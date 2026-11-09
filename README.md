# 填空报销

把报销从「对着表格填空」变成「**把发票全丢进来 → AI 按团队规范一句句问 → 生成草稿 → 提交飞书**」。

公网演示：https://baoxiao.xbchen.top （硬刷新；资源带 `?v=` 防缓存）

## 产品故事（默认体验）

1. **丢发票**：先用飞书登录，一个大拖放区，一次多张 PDF / 图片，不必先选场景或按天找槽位。
2. **识别**：`/api/parse-invoice`：文字 PDF 抽文本；图片先经本机 Xiaomi-OCR 抽全文，再启发式抽取，并用文本大模型校对。登录后可在顶栏「AI 设置」填写自己的 OpenAI 兼容接口（**推荐使用 Deepseek**，默认 `https://api.deepseek.com/v1` + `deepseek-chat`）。未配置时回退到本机 Ollama 校对。
3. **汇总表**：识别完成后出现可编辑汇总表（日期 / 商户 / 发票号码 / 金额 / 类别）。用户确认或手改后，**以表格为准**进入问答和草稿。
4. **问答**：按项目名称组织逐票问题，本地历史常用答案置顶高亮（仍需用户选择），从飞书实时读取采购申请定义，**一次只问一个问题**，收集采购方式、项目、采购事由、关联预算，以及当前方式的科目/规格/数量等必填项。七种方式按定义切换明细；合同/预付多收集收款信息，京东收集采购清单，差旅收集费用类型。
5. **草稿**：可编辑明细与「识别汇总」同步；金额、日期、商户、发票号均取确认后的表格。采购专用字段在行内「采购明细」展开编辑。
6. **提交飞书采购申请**：按钮调用 `POST /api/feishu-expense` → 飞书原生 `POST /approval/v4/instances/initiate`。服务端验证 OAuth 用户，直接使用该用户的 `user_access_token` 发起，创建在登录用户的名下。成功必须有真实 `instance_code`，页面显示审批链接与单号；错误不会回退成成功。

会话落在 `localStorage` 键 `fill-blank-expense:delight:v1`。

旧版「按场景填空」仍在 [`web/classic/`](web/classic/)（页头「经典填空」入口），默认落地页是新流程。

## 怎么在 baoxiao 上试（5 步）

1. 打开 https://baoxiao.xbchen.top 并 **硬刷新**（应看到「把发票全丢进来」英雄区，而不是差旅 Tab）。
2. 一次拖入 **多张** 发票（可用仓库里的 `test-invoice.pdf` + 任意图片）；等待出现「识别汇总」表。
3. 在表里核对金额（价税合计）、日期、商户、发票号码，改完点 **确认表格，开始问答**；用 chips 或输入框逐题回答。
4. 问完后进入 **采购申请草稿**；核对项目、科目、规格、数量，编辑金额后合计同步更新。
5. **确认，去提交飞书** → **发起飞书采购申请**。成功显示真实实例编号、单号和「打开飞书采购申请」；缺权限显示具体错误与开通链接。

## 本地启动

```bash
./restart-local.sh
# 或分别：
# python3 ocr/server.py          → :18790
# python3 web/serve.py --port 5173
```

- 前端：http://127.0.0.1:5173
- OCR / API：`GET /api/health` · `POST /api/parse-invoice` · `POST /api/feishu-expense`（真实采购审批） · `GET /api/purchase-schema`（实时字段选项） · `GET/PUT /api/ai-settings` · `POST /api/ai-settings/test`
- 飞书登录：`GET /api/auth/feishu/login` → 回调 `/api/auth/feishu/callback` · `GET /api/auth/me` · `POST /api/auth/logout` · `GET /api/budgets`（当前用户已通过的立项/变更/出差）
- 在页面点「用飞书登录」，授权后可点选已通过预算，问答会自动带上项目；顶栏「AI 设置」可填写自己的大模型接口
- 凭证放仓库根目录 `.env`（见 `.env.example`，不要提交）。需配置重定向 URL `https://baoxiao.xbchen.top/api/auth/feishu/callback`
- 隧道：`baoxiao.xbchen.top` 的 `/api` → OCR `:18790`，其余 → web `:5173`

## 采购申请定义与权限

- 定义：`D448D0FB-77DB-4640-9650-1FB99512888C`（采购申请）。`ocr/purchase_definition.json` 是核验用表单快照；运行时读取飞书实时定义，定义不匹配或新增未映射的必填项会阻止提交。
- 采购方式 / 项目：显示文字转换为各自 `radioV2` 选项 value；采购事由 → `textarea`。
- 发票：确认后的金额 → 当前明细组的金额（CNY）；商户 → 名称；日期、发票号、备注 → 备注。每张发票一行，科目使用该方式自己的选项 value，规格与数量由用户确认。
- 关联审批 → `widget17901536351250001` 的 `connect` 实例 code 数组。除预付款项外必填；后端重新核验定义、通过状态与用户范围，仅允许立项预算、项目预算变更或出差申请。主页继续只列立项与变更预算。
- 发起使用新的用户接口 `POST /approval/v4/instances/initiate`，只接受当前 OAuth 用户凭证，客户端不能指定申请人；不会回退到应用凭证创建。旧接口 `POST /instances` 只支持应用 token，不使用它。
- 发起所需**用户身份**权限：`approval:instance:write`；登录请求会合并该 scope，即使 `.env` 保留旧 scope 也会补齐。旧用户未授权时需要退出再登录；权限错误展示真实错误、管理员开通链接与重新授权入口。
- 定义和预算读取继续使用现有应用身份只读权限 `approval:approval:readonly`、`approval:approval.list:readonly`。本实现不要求新增用户 `approval:approval:read`，也不要求开通应用写权限。
- 2026-11-09 实测：现有登录会话包含 `approval:instance:write`；对 `/instances/initiate` 使用不存在的定义探测，返回 `1390001 approval code not found`（已通过 token / scope 校验）。当前定义读取成功，七种条件明细已核实；真实定义的流程预览返回 code 0。测试没有发起生产采购申请。
- 同一用户与相同表单生成稳定 UUID；`.submissions.sqlite3` 保存请求状态与真实回执（0600，忽略提交）。重复点击/刷新复用成功回执；超时或中断后状态待确认，阻止重复创建，须先在飞书核对。不要删除此数据库来重试未知结果。
- 发票原件先保存到 Mini，提交前校验归属和完整性，上传到审批系统并将原生附件 code 关联到 `attachmentV2`。每张票必须有原件；旧草稿可补传，手改事实不被覆盖。审批发起仍走用户 OAuth。

### 验证

```bash
python3 -m unittest discover -s ocr -v
python3 ocr/test_invoice_extract.py
node web/test-purchase-policy.cjs
node --check web/app.js
```

七种明细的条件切换、精确选项映射、关联范围/必填、OAuth 发起人绑定、权限失败、超时防重复、真实链接/单号回执均有离线测试。线上创建权限探测只用不存在的定义，不发起测试采购；真实采购定义的流程预览（指定现有部门 ID）返回 code 0。用实际发票完成一次公网流程，在该登录用户的飞书「已发起」核对。

本地建议库及附件的 DB schema、权限、失败语义与复测步骤见 [docs/feishu-purchase.md](docs/feishu-purchase.md)。

## OCR 与校对

`web/ocr-bridge.js` 设置 `window.__invoiceOCR`。本机直连 `http://127.0.0.1:18790`；公网走同源 `/api`。

管道：

1. **文字 PDF**：`pdftotext -layout` / PyMuPDF 抽文本。
2. **图片**（JPG/PNG/WebP/HEIC）：先纠正 EXIF、缩到最长边 2048 并转 JPEG，再用 `longwayxu/xiaomi-ocr-0:bf16` **识别全部可见文字**（不再让视觉模型直接猜 JSON 金额——它容易把未税「合计」299.11 当成价税合计 338.00）。
3. **启发式 KIE**：从全文抓价税合计、销售方、开票日期、发票号码。
4. **文本 LLM 校对**：把原文 + 初解析送进统一的 `ocr/ai_client.py`。若当前登录用户已在「AI 设置」填写接口，则用该接口（推荐 Deepseek / `deepseek-chat`）；否则回退本机 `INVOICE_REVIEW_MODEL`。校对结果必须能在原文中找到，且启发式已经命中「价税合计」时不会被较弱猜测覆盖。都不可用时会提示去配置 AI，而不是悄悄跳过。
5. 文本稀疏的 PDF 仍回退到首页栅格化 + 上述图片管道。

## AI 设置

所有大模型调用都经过 `ocr/ai_client.py` 的 OpenAI 兼容 `chat/completions`。登录用户可在顶栏打开「AI 设置」填写：

- API Base URL（Deepseek 示例：`https://api.deepseek.com/v1`，请带上 `/v1`）
- API Key（按用户 `open_id` 加密存在 `.expense-data.sqlite3`，接口只回 `sk-***` + 后四位；可用环境变量 `BAOXIAO_SECRETS_KEY` 作为加密密钥）
- 文本 / 校对模型（推荐 `deepseek-chat`）
- 可选视觉模型（当前图片识别仍走本机 OCR，此栏预留）

图片文字识别默认仍用本机 OCR；字段校对 / 文本 AI 用你配置的接口（推荐 Deepseek）。问答暂未接大模型，但客户端预留了 `chat_for_qa` 钩子，以后不会再散落 URL 和密钥。

桥接失败时前端 mock 仅用于无 OCR 本地点点看。

## 技术

纯 HTML / CSS / JS。入口 `web/index.html`；样式 `web/styles.css`；逻辑 `web/app.js`；政策 `web/policy.js`；OCR `web/ocr-bridge.js` + `ocr/server.py`。

## 尚未实现

- LLM 问答（`ai_client.chat_for_qa` 已预留，当前仍是规则题 + 历史建议）
- 与 invoice-assistant 深度对接
