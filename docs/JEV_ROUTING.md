# Jev + 文本模型（2026-11-11）

## 文件级实现

- `ocr/jev_settings.py`：团队统一共享 Jev 配置（以管理员 open_id `ou_ec0bada34f29c4020d794b917b4e7fbb` 为准），复用既有认证加密；`jev_settings(owner PRIMARY KEY, base_url, api_key_enc, model, updated_at)`。全员封闭选项共享管理员配置的 Jev；DeepSeek 等文本模型接口严格保持用户级隔离，绝不回退至他人密钥。
- `ocr/jev_client.py`：原生 HTTPS `POST /v1/systemone`，不走 chat/completions，不发送 Images / Long Context 头，不跟随携带密钥的重定向，不展示上游响应正文。
- `ocr/choice_suggestions.py`：从服务端现行采购 definition 的真实选项组装问题；每张票一次请求并行所有封闭问题 + companion Noul。餐饮多数为招待费仅是说明，禁止硬编码或新增选项。
- `ocr/server.py`：登录与同源保护下的 `/api/jev-settings` GET/PUT、`/api/jev-settings/test` POST、`/api/choice-suggestions` POST。owner 始终来自当前会话。
- `web/index.html` / `app.js` / `policy.js`：现有 AI 设置窗口中增加独立 Jev 区域与保存/测试/清除；显示来源、置顶选项，保留历史排序和明确点选。异步建议只更新 chips，保留输入、焦点和聊天滚动；旧用户/旧草稿/旧票面响应丢弃。

## 分流

1. Jev 默认根地址 `https://api.typesafe.ai`，默认模型 `jev-latest`，均可改。官方 models 文档在实施时指向 `jev-1.14.0`。
2. 先验证 `confidence >= JEV_CONFIDENCE_THRESHOLD = 0.5`；概率分布须完整合法、选中项须为最高概率真实选项；前两项差值 `>= JEV_TOP_TWO_MARGIN = 0.10`；companion Noul `>= JEV_FIT_THRESHOLD = 0.70`。
3. 只把未通过的那些问题交给当前用户的文本模型；未配置文本接口则沿用本机 Ollama endpoint。401/429/网络/无效 JSON 都回退，不输出上游敏感正文。文本模型也失败则保留历史建议及手选，绝不假报成功。文本返回 null 或虚构选项不展示为建议。
4. state 白名单仅项目、方式、事由、金额、品类、数量单位和明细；不传原图、附件、票号、银行资料。每票最多40条明细，每条字段截断。OCR 和原有文本字段校对的稳定接口保持。
5. 所有结果只是建议：不修改 invoice/category/answers。已选答案始终优先。旧票面/账号/草稿结果不落 UI。
6. 后端按 owner、票面、问题与凭据哈希做10分钟有界内存缓存（发生回退则只缓存30秒）与同请求合并，最多256组，最多4张票并发。前端成功建议缓存10分钟，相同事实只取一次；重新进入问答可重试失败建议；科目点选不会重复调用；改票面/项目/方式/事由会重新判断。密钥只加密持久化，缓存键不保留密钥原文；重启清空内存缓存。

## UI 与边界

- 管理员可在「AI 设置」中配置、测试和清除团队 Jev；普通同事访问时直接展示「团队已共用 Jev」，隐藏/禁用密钥输入与测试按钮，无需也无法输入 Jev 密钥，且后端绝不向同事回传管理员密钥（包含掩码）。DeepSeek 与其他文本接口继续由个人按需填写。
- 开放问题继续由用户填写；现有文本校对/生成使用原有文本接口，本次不增加开放字段自动填入。
- OAuth、采购映射/提交、附件、数量、去重、银行档案、草稿/历史和用户密钥隔离均保留。无生产审批/真实消息测试。
- 测试使用临时 SQLite、合成发票和模拟 HTTP；不读取任何真实密钥或真实票面作测试。真实 Jev 付费调用留给用户在 AI 设置点击测试。

## 官方依据

- https://docs.typesafe.ai/api/system-one.md
- https://docs.typesafe.ai/primitives/choice.md
- https://docs.typesafe.ai/confidence.md
- https://docs.typesafe.ai/patterns/confidence-routing.md
- https://docs.typesafe.ai/patterns/companion-noul.md
- https://docs.typesafe.ai/models.md

## 验证结果

- Python 全量 135 项通过（包含 Jev 原生请求/脱敏、置信度/概率差/Noul、部分回退、真实选项、owner 隔离、临时 SQLite 加密与现行 HTTP 认证测试）。
- 8 组前端测试通过；新增 test-jev.cjs 覆盖相同事实复用、改票面重判、旧 owner/旧 revision 丢弃、手选优先、错误降级与 DOM 设置字段。Python compileall、JS 语法和 git diff --check 通过。
- 真实选定 Browser 中运行完全拦截网络的合成页面：独立保存 Jev、测试连接、Jev 建议置顶/来源显示均通过；390px、768px iframe 视口无横向溢出，设置正文可滚动，密码框 type=password。桌面同样无横向溢出。未生成截图，未声称完成像素视觉验收。
- 不使用真实 Jev/DeepSeek 密钥作测试，不读取真实发票，不发生产审批或消息。
