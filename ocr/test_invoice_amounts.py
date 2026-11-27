"""Money precision and authoritative original checks; synthetic files only."""
from decimal import Decimal
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import approval_files
import expense_data as data
import filling_workflow as flow
import invoice_amounts as amounts
import invoice_extract as extract
from test_feishu_purchase import claim_for, SCHEMA


class MoneyParserTests(unittest.TestCase):
    def test_fullwidth_fare_keeps_fen_and_rejects_integer_prefix(self):
        text = '电子发票（铁路电子客票）\n票价：￥６９．５０'
        self.assertEqual(extract.parse_invoice_from_text(text)['amount'], 69.5)
        self.assertEqual(amounts.total_evidence(text)[0], Decimal('69.50'))
        self.assertFalse(extract._value_in_text(69.0, text))
        self.assertFalse(extract._value_in_text(69, text))
        self.assertFalse(extract._value_in_text(6950.0, text))
        self.assertTrue(extract._value_in_text(69.5, text))
        heuristic = extract.parse_invoice_from_text(text)
        self.assertEqual(extract.merge_heuristic_and_review(heuristic, {'amount':69.0}, text)['amount'], 69.5)

    def test_complete_decimal_tokens_and_grouping(self):
        for text, expected in [('票价: ¥49.50', '49.50'), ('实付：￥１，２３４．５６', '1234.56'),
                               ('价税合计 (小写) ¥69. 50', '69.50'), ('票价:¥0.05', '0.05')]:
            with self.subTest(text=text):self.assertEqual(amounts.total_evidence(text)[0], Decimal(expected))
        for text in ['票价: ¥69,5', '票价: ¥69.501', '票价: ¥69..50']:
            self.assertIsNone(amounts.total_evidence(text), text)
            self.assertIsNone(extract._parse_amount(text)[0], text)
        with self.assertRaises(ValueError):extract.coerce_fields({'amount':'69,5'})

    def test_paper_rail_voucher_requires_a_unique_currency_amount(self):
        self.assertEqual(amounts.total_evidence('南沙北站 香港西九龙站\n¥185.0元\n仅供报销使用')[0],Decimal('185.00'))
        with self.assertRaisesRegex(ValueError,'矛盾'):
            amounts.total_evidence('仅供报销使用\n¥185.0元\n¥120.0元')

    def test_gross_total_and_uppercase_crosscheck(self):
        text = '未税合计 ¥65.57 税额 ¥3.93\n价税合计（大写）陆拾玖圆伍角（小写）￥69.50'
        self.assertEqual(amounts.total_evidence(text)[0], Decimal('69.50'))
        with self.assertRaisesRegex(ValueError, '大小写'):
            amounts.total_evidence(text.replace('69.50','69.00'))
        with self.assertRaisesRegex(ValueError, '矛盾'):
            amounts.total_evidence('价税合计:¥69.50\n价税合计:¥69.00')


class OriginalAmountTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        for name, value in [('DB_PATH',Path(self.temp.name)/'data.db'),('FILE_ROOT',Path(self.temp.name)/'files')]:
            p=patch.object(data,name,value);p.start();self.addCleanup(p.stop)
        self.ref = data.save_file('alice',b'%PDF synthetic 69.50','fixture.pdf','application/pdf')
        self.record,self.raw = data.resolve_file('alice',self.ref)

    def test_mismatch_blocks_preview_even_when_client_raw_and_name_claim_69(self):
        c=claim_for();c['invoices'][0].update(amount='69',raw='价税合计:¥69.00',fileName='fixture-69.pdf',attachment=self.ref)
        with patch.object(extract,'extract_pdf_text',return_value='票价：￥６９．５０'), patch.object(approval_files,'upload_file') as upload:
            with self.assertRaisesRegex(ValueError, '清单 ¥69.00.*原件票价 ¥69.50.*差额 ¥0.50'):
                flow.review('alice',c,SCHEMA)
            upload.assert_not_called()
            c['invoices'][0]['amount']='69.50'
            self.assertEqual(flow.review('alice',c,SCHEMA)['attachmentCount'],1)

    def test_only_immutable_original_evidence_is_cached(self):
        with patch.object(extract,'extract_pdf_text',return_value='票价：￥６９．５０') as read:
            amounts.validate_amount(self.record,self.raw,'69.50')
            with self.assertRaisesRegex(ValueError,'差额 ¥0.50'):
                amounts.validate_amount(self.record,self.raw,'69')
            read.assert_called_once()
        # A new original has a new hash and must be read again, even for the same user.
        ref=data.save_file('alice',b'%PDF synthetic 70.00','fixture.pdf','application/pdf')
        record,raw=data.resolve_file('alice',ref)
        with patch.object(extract,'extract_pdf_text',return_value='票价:¥70.00') as read:
            amounts.validate_amount(record,raw,'70.00');read.assert_called_once()

    def test_unreadable_original_cannot_be_reported_as_checked(self):
        with patch.object(extract,'extract_pdf_text',return_value=''),patch.object(extract,'pdf_to_png_bytes',return_value=(b'fixture','image/png')),patch.object(extract,'call_ollama_ocr_text',return_value='没有可核验金额'):
            with self.assertRaisesRegex(ValueError,'不能视为金额核对通过'):
                amounts.validate_amount(self.record,self.raw,'69.50')

    def test_image_original_rechecks_server_ocr_text_instead_of_cached_amount(self):
        with data.database() as con:
            con.execute('INSERT INTO invoice_reads VALUES(?,?,?,?)',(self.record['sha256'],'done',json.dumps({'amount':69,'raw':'票价：￥６９．５０'}),0))
        with patch.object(extract,'extract_pdf_text',return_value=''),patch.object(extract,'call_ollama_ocr_text') as ocr:
            self.assertEqual(amounts.original_amount(self.record,self.raw)[0],Decimal('69.50'))
            ocr.assert_not_called()

    def test_all_mismatching_rows_are_reported_together(self):
        other=data.save_file('alice',b'%PDF synthetic 49.50','other.pdf','application/pdf')
        claim={'invoices':[{'amount':'69','attachment':self.ref},{'amount':'49','attachment':other}]}
        with patch.object(extract,'extract_pdf_text',side_effect=lambda raw:'票价:¥'+raw.decode().split()[-1]):
            with self.assertRaises(ValueError) as caught:approval_files.resolve_invoices('alice',claim,verify_amounts=True)
        self.assertIn('¥69.50',str(caught.exception));self.assertIn('¥49.50',str(caught.exception))
