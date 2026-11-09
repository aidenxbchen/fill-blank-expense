# 填空报销

把报销从「对着表格填空」变成「**把发票全丢进来 → AI 按团队规范一句句问 → 生成草稿 → 提交飞书**」。

公网演示：https://baoxiao.xbchen.top （硬刷新；资源带 `?v=` 防缓存）

## 产品故事（默认体验）

1. **丢发票**：一个大拖放区，一次多张 PDF / 图片，不必先选场景或按天找槽位。
2. **识别**：`/api/parse-invoice`：文字 PDF 抽文本；图片先经 Xiaomi-OCR 抽全文，再启发式抽取，并用本地大模型校对（默认 `longwayxu/xiaomi-ocr-0:bf16` 文本模式，避免 8GB Mini 再加载 `gemma:7b` 把视觉模型挤出显存。可用环境变量 `INVOICE_REVIEW_MODEL=gemma:7b` 改用 Gemma）。
3. **汇总表**：识别完成后出现可编辑汇总表（日期 / 商户 / 发票号码 / 金额 / 类别）。用户确认或手改后，**以表格为准**进入问答和草稿。
4. **问答**：按内置 `POLICY`（典型中国初创规范）**一次只问一个问题**（事由、项目/成本中心、谁吃了、有无酒水、对公/私人、缺日期、类别冲突、无票现金等）。Chips + 自由输入；进度「还差 N 个问题」。
5. **草稿**：按类别生成可编辑明细表 + 摘要字段（含发票号码）；可改、可加无票行。
6. **提交飞书**：以当前飞书 OAuth 身份调用原生采购申请 `/instances/initiate`；采购方式、项目、事由和对应明细必填，选中预算写入关联审批。只有飞书返回真实 `instance_code` 才显示成功。详见 [接入与复测](docs/feishu-purchase.md)。

会话落在 `localStorage` 键 `fill-blank-expense:delight:v1`。

旧版「按场景填空」仍在 [`web/classic/`](web/classic/)（页头「经典填空」入口），默认落地页是新流程。

## 怎么在 baoxiao 上试（5 步）

1. 打开 https://baoxiao.xbchen.top 并 **硬刷新**（应看到「把发票全丢进来」英雄区，而不是差旅 Tab）。
2. 一次拖入 **多张** 发票（可用仓库里的 `test-invoice.pdf` + 任意图片）；等待出现「识别汇总」表。
3. 在表里核对金额（价税合计）、日期、商户、发票号码，改完点 **确认表格，开始问答**；用 chips 或输入框逐题回答。
4. 问完后自动进入 **报销草稿**：检查分类表；提交所用发票事实以第 3 步识别汇总表为准（含金额、商户、日期和发票号），无票占位行不自动提交。
5. 先飞书登录并选择已通过的立项 / 变更预算；**确认，去提交飞书** → 选择采购方式、项目，补全科目 / 规格 / 数量等必填明细 → **发起飞书采购申请**。成功显示真实实例 Code 与接口返回的链接；到飞书「我发起的」核对。出差可填实例 Code 替代预算，预付款项不要求关联审批。

## 本地启动

```bash
./restart-local.sh --restart   # 校验旧进程归属，重载 API / web
# 或分别：
# python3 ocr/server.py          → :18790
# python3 web/serve.py --port 5173
```

- 前端：http://127.0.0.1:5173
- OCR / API：`GET /api/health` · `POST /api/parse-invoice` · `POST /api/feishu-expense`（真实采购申请） · `GET /api/feishu-purchase-definition`
- 飞书登录：`GET /api/auth/feishu/login` → 回调 `/api/auth/feishu/callback` · `GET /api/auth/me` · `POST /api/auth/logout` · `GET /api/budgets`（当前用户范围内已通过的立项/变更；出差不混入预算列表）
- 在页面点「用飞书登录」，授权后可点选已通过预算，问答会自动带上项目
- 凭证放仓库根目录 `.env`（见 `.env.example`，不要提交）。需配置重定向 URL `https://baoxiao.xbchen.top/api/auth/feishu/callback`
- 隧道：`baoxiao.xbchen.top` 的 `/api` → OCR `:18790`，其余 → web `:5173`

## 报销政策（mock）

- JS：`web/policy.js` → `window.ExpensePolicy.POLICY` + `buildQuestionQueue` / `nextQuestion`
- JSON 镜像：`web/policy.json`
- v1 **纯规则引擎**（无外部 LLM）；预留 `window.__expenseInterviewLLM` 挂钩，便于后续接入模型。

规则示例：强制事由；采购要项目名；招待要对方公司；餐饮问同席/酒水/对公私人；可选差旅餐住上限软提醒；缺日期与商户-类别冲突会追问。

## OCR 与校对

`web/ocr-bridge.js` 设置 `window.__invoiceOCR`。本机直连 `http://127.0.0.1:18790`；公网走同源 `/api`。

管道：

1. **文字 PDF**：`pdftotext -layout` / PyMuPDF 抽文本。
2. **图片**（JPG/PNG/WebP/HEIC）：先纠正 EXIF、缩到最长边 2048 并转 JPEG，再用 `longwayxu/xiaomi-ocr-0:bf16` **识别全部可见文字**（不再让视觉模型直接猜 JSON 金额——它容易把未税「合计」299.11 当成价税合计 338.00）。
3. **启发式 KIE**：从全文抓价税合计、销售方、开票日期、发票号码。
4. **本地 LLM 校对**：把原文 + 初解析再送进 `INVOICE_REVIEW_MODEL`（默认仍是 Xiaomi-OCR 的文本聊天模式，无需云端 key）。校对结果必须能在原文中找到，且启发式已经命中「价税合计」时不会被较弱猜测覆盖。
5. 文本稀疏的 PDF 仍回退到首页栅格化 + 上述图片管道。

桥接失败时前端 mock 仅用于无 OCR 本地点点看。

## 技术

纯 HTML / CSS / JS。入口 `web/index.html`；样式 `web/styles.css`；逻辑 `web/app.js`；政策 `web/policy.js`；OCR `web/ocr-bridge.js` + `ocr/server.py`。

## 尚未实现

- 真实飞书审批实例创建
- LLM 问答（结构已预留）
- 与 invoice-assistant 深度对接
