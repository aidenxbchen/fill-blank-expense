import copy
import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import Mock, patch

import ai_settings
import choice_suggestions as choices
import expense_data as data
import jev_client
import jev_settings
from feishu_purchase import public_schema
from test_feishu_purchase import SCHEMA


class JevTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        for key, value in [('DB_PATH', Path(tmp.name)/'data.db'), ('FILE_ROOT', Path(tmp.name)/'files')]:
            p = patch.object(data, key, value); p.start(); self.addCleanup(p.stop)
        p = patch.dict('os.environ', {'BAOXIAO_SECRETS_KEY':'synthetic-test-encryption', 'ORG_JEV_OWNER_OPEN_ID':'alice'}); p.start(); self.addCleanup(p.stop)
        choices._cache.clear()
        self.schema = public_schema(SCHEMA)
        self.claim = {'costCenter':'公共办公','purchaseMethod':'差旅费',
            'answers':{'costCenter':'公共办公', 'purchaseMethod':'差旅费','purpose':'合成测试用途'},
            'invoices':[{'id':'synthetic','category':'meal','amount':128,'quantity':1,'unit':'份',
                         'items':[{'name':'餐饮服务','quantity':1,'unit':'份'}],
                         'attachment':{'fileId':'must-not-send'},'invoiceNo':'must-not-send'}]}
        # Use the live actual method name; no invented production option.
        self.method = next(m for m in self.schema['methods'] if any(w['name']=='费用类型' for w in m['fields']))
        self.claim['purchaseMethod'] = self.claim['answers']['purchaseMethod'] = self.method['name']

    def save_jev(self, owner='alice'):
        return jev_settings.save(owner, {'apiKey':'synthetic-private-key','model':'jev-latest'})

    @staticmethod
    def answer(**kwargs):
        result = {}
        for ident, question in kwargs['questions'].items():
            if question['type']=='noul': result[ident]={'type':'noul','noul':.95}; continue
            options=list(question['criteria']);n=len(options)
            probs={o:(1 if n==1 else .9 if i==0 else .1/(n-1)) for i,o in enumerate(options)}
            result[ident]={'type':'choice','choice':options[0],'confidence':.9,'probabilities':probs}
        return {'model':'jev-1.14.0','answers':result}

    def test_encrypted_owner_isolation_blank_key_preserve_clear(self):
        view=self.save_jev()
        self.assertTrue(view['configured']); self.assertTrue(view['isOrgOwner']); self.assertNotIn('synthetic-private-key',json.dumps(view))
        with data.database() as con:
            cipher=con.execute('SELECT api_key_enc FROM jev_settings WHERE owner=?',('alice',)).fetchone()[0]
        self.assertNotIn('synthetic-private-key',cipher)
        self.assertIsNone(jev_settings.load_credentials('bob'))
        with self.assertRaises(ai_settings.SettingsError): jev_settings.save('bob',{'apiKey':'key'})
        bob_view = jev_settings.public_view('bob')
        self.assertTrue(bob_view['configured'])
        self.assertTrue(bob_view['orgShared'])
        self.assertFalse(bob_view['isOrgOwner'])
        self.assertFalse(bob_view['settings']['hasApiKey'])
        self.assertEqual(bob_view['settings']['apiKeyMasked'], '')
        self.assertNotIn('synthetic-private-key', json.dumps(bob_view))
        jev_settings.save('alice',{'apiKey':'','baseUrl':'https://api.typesafe.ai/v1','model':'jev-1.14.0'})
        self.assertEqual(jev_settings.load_credentials('alice')['model'],'jev-1.14.0')
        self.assertEqual(jev_settings.load_credentials('alice')['api_key'],'synthetic-private-key')
        jev_settings.save('alice',{'clear':True})
        self.assertFalse(jev_settings.public_view('alice')['configured'])
        self.assertFalse(jev_settings.public_view('bob')['configured'])

    def test_damaged_key_and_global_key_never_fallback(self):
        self.save_jev()
        with data.database() as con: con.execute("UPDATE jev_settings SET api_key_enc='broken'")
        with patch.dict('os.environ',{'TYPESAFE_API_KEY':'must-not-use'}):
            self.assertIsNone(jev_settings.load_credentials('alice'))
            self.assertIsNone(jev_settings.load_credentials('bob'))

    def test_existing_text_resolver_isolates_users(self):
        ai_settings.save('alice',{'baseUrl':'https://api.deepseek.com/v1','apiKey':'synthetic-alice-only','textModel':'deepseek-chat'})
        endpoint,source=choices.resolve_review_endpoint('alice')
        self.assertEqual(source,'user');self.assertEqual(endpoint['api_key'],'synthetic-alice-only')
        endpoint,source=choices.resolve_review_endpoint('bob')
        self.assertEqual(source,'ollama');self.assertNotEqual(endpoint['api_key'],'synthetic-alice-only')

    def test_partial_fallback_only_retries_uncertain_questions(self):
        self.save_jev()
        def partial(**kwargs):
            response=self.answer(**kwargs)
            response['answers']['q0']['confidence']=.1
            return response
        with patch.object(jev_client,'system_one',side_effect=partial), patch.object(choices.ai_client,'chat_completions',return_value='{}') as text:
            result=choices.suggest('alice',self.claim,self.schema)
        sent=json.loads(text.call_args.kwargs['messages'][1]['content'])
        self.assertEqual(len(sent['questions']),1)
        self.assertEqual(len(result['rows']['synthetic']),1)

    def test_base_validation(self):
        for value in ['http://api.typesafe.ai','https://user:secret@api.typesafe.ai','https://api.typesafe.ai/v1/systemone','https://api.typesafe.ai?key=secret']:
            with self.subTest(value=value), self.assertRaises(ai_settings.SettingsError): jev_settings.validate_base(value)

    def test_native_request_shape_and_redacted_errors(self):
        reply=Mock();reply.__enter__=Mock(return_value=reply);reply.__exit__=Mock(return_value=False)
        reply.read.return_value=b'{"answers":{}}'
        opener=Mock();opener.open.return_value=reply
        params=dict(base_url='https://api.typesafe.ai',api_key='synthetic-secret',model='jev-latest',state={'amount':128},questions={'nature':{'type':'choice','criteria':{'A':'A'}}})
        with patch.object(jev_client.urllib.request,'build_opener',return_value=opener):
            jev_client.system_one(**params)
        request=opener.open.call_args.args[0]
        self.assertEqual(request.full_url,'https://api.typesafe.ai/v1/systemone')
        self.assertEqual(set(json.loads(request.data)),{'model','state','questions'})
        self.assertEqual(request.get_header('Authorization'),'Bearer synthetic-secret')
        self.assertNotIn('TypeSafe-Danger-Zone-Long-Context',dict(request.header_items()))
        for status in [401,429,500]:
            opener.open.side_effect=urllib.error.HTTPError(request.full_url,status,'secret-echo',{},io.BytesIO(b'synthetic-secret'))
            with patch.object(jev_client.urllib.request,'build_opener',return_value=opener), self.assertRaises(jev_client.JevError) as ctx:
                jev_client.system_one(**params)
            self.assertNotIn('synthetic-secret',str(ctx.exception))

    def test_confidence_margin_fit_and_invalid_outputs(self):
        good={'choice':'A','confidence':.5,'probabilities':{'A':.8,'B':.2}}
        self.assertTrue(choices.trusted_choice(good,['A','B'],.7))
        cases=[dict(good,confidence=.499),dict(good,confidence=float('nan')),
               dict(good,probabilities={'A':.54,'B':.46}),dict(good,choice='invented'),
               dict(good,choice='B'),dict(good,probabilities={'A':1}),
               dict(good,probabilities={'A':.9,'B':.9})]
        for case in cases: self.assertFalse(choices.trusted_choice(case,['A','B'],.9))
        for fit in [None,.3,.699,float('nan')]: self.assertFalse(choices.trusted_choice(good,['A','B'],fit))

    def test_live_options_batched_no_image_answers_unchanged_and_cached(self):
        self.save_jev(); before=copy.deepcopy(self.claim)
        with patch.object(jev_client,'system_one',side_effect=self.answer) as remote, patch.object(choices.ai_client,'chat_completions') as text:
            first=choices.suggest('alice',self.claim,self.schema)
            choices.suggest('alice',self.claim,self.schema)
            self.assertEqual(remote.call_count,1);text.assert_not_called()
        args=remote.call_args.kwargs
        self.assertEqual(self.claim,before)
        self.assertNotIn('must-not-send',json.dumps(args['state']))
        live={w['name']:w['options'] for w in self.method['fields'] if w['required'] and w['options']}
        self.assertEqual(len(args['questions']),2*len(live))
        for q in args['questions'].values():
            if q['type']=='choice':
                self.assertIn(list(q['criteria']),list(live.values()))
                self.assertIn('多数属于招待费',q['instructions']);self.assertIn('禁止编造',q['instructions'])
        self.assertTrue(first['rows']['synthetic'])

    def test_low_confidence_failure_missing_fallback_and_deleted_option(self):
        self.save_jev()
        field=next(w for w in self.method['fields'] if w['required'] and w['options'])
        endpoint={'base_url':'https://own.example/v1','api_key':'alice-only','model':'text'}
        low=self.answer(state={},questions={'q':{'type':'choice','criteria':{'A':'a','B':'b'}}})
        for failure in [RuntimeError('secret-must-not-leak'), None]:
            choices._cache.clear()
            with patch.object(jev_client,'system_one',side_effect=failure,return_value=low) as jev, patch.object(choices,'resolve_review_endpoint',return_value=(endpoint,'user')), patch.object(choices.ai_client,'chat_completions',return_value=json.dumps({field['name']:field['options'][0]})) as text:
                result=choices.suggest('alice',self.claim,self.schema)
                self.assertEqual(text.call_args.kwargs['api_key'],'alice-only')
                self.assertTrue(result['rows']['synthetic']);self.assertNotIn('secret-must-not-leak',str(result))
        choices._cache.clear()
        with patch.object(jev_settings,'resolve_credentials',return_value=None), patch.object(jev_client,'system_one') as jev, patch.object(choices,'resolve_review_endpoint',return_value=({'base_url':'http://127.0.0.1:11434/v1','api_key':'','model':'local'},'ollama')), patch.object(choices.ai_client,'chat_completions',return_value=json.dumps({field['name']:'invented option'})) as text:
            result=choices.suggest('bob',self.claim,self.schema)
            jev.assert_not_called();self.assertEqual(text.call_args.kwargs['base_url'],'http://127.0.0.1:11434/v1')
            self.assertFalse(result['rows']['synthetic'])

    def test_cache_owner_and_fact_revision_isolation(self):
        self.save_jev()
        with patch.object(jev_client,'system_one',side_effect=self.answer) as remote, patch.object(choices.ai_client,'chat_completions'):
            choices.suggest('alice',self.claim,self.schema)
            choices.suggest('bob',self.claim,self.schema)
            self.claim['invoices'][0]['amount']=129
            choices.suggest('alice',self.claim,self.schema)
            self.assertEqual(remote.call_count,3)



    def test_default_org_owner_id_and_sharing(self):
        with patch.dict('os.environ', {}, clear=True):
            self.assertEqual(jev_settings.org_owner_id(), 'ou_ec0bada34f29c4020d794b917b4e7fbb')
            self.assertTrue(jev_settings.is_org_owner('ou_ec0bada34f29c4020d794b917b4e7fbb'))
            self.assertFalse(jev_settings.is_org_owner('colleague_open_id'))

if __name__=='__main__': unittest.main()
