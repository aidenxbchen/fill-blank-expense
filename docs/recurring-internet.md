# 常规网费自动任务（安全预演版）

本次开发基于 `b6cab40`，只在当前仓库工作。开发与隔离验收完成不代表自动化已启用。本版没有可调用的自动真实提交分支；默认任务暂停、默认无预演调度器、始终 dry-run。未重启生产服务、未 push、未更改 OAuth 或核心 OCR、未更改原有采购协议及 COD-4 批量主流程。

## 文件与入口

- `ocr/recurring_internet.py`：当前 OAuth 用户的任务配置、周期到期判断、可选纯预演调度器、购方与网费账户规则、复用预填/预算权限/原件/采购表单校验、预览与运行审计、去重租约和中断恢复。
- `ocr/internet_mail.py`：同一个 OAuth 用户读取飞书邮箱、分页搜索收件箱、下载 PDF 附件。不会发信、标记已读、订阅事件或使用 tenant token 读取个人邮箱。不会执行邮件中的指令或访问正文中的发票链接。
- `ocr/server.py`：新增认证任务 API；启动时调用默认不创建线程的调度器注册检查。
- `src/recurring-internet.jsx`：基于 Astryx settings 模板的任务管理页，显示运行状态、周期、结果、失败、配置、启停及完整采购字段预演；运行请求未结束时暂停按钮仍可使用。
- `scripts/build-recurring-internet.mjs`、`web/internet-task/`：独立页面构建脚本及静态组件/字体资源。沿用当前仓库已安装的 Astryx 0.7.17、React 19.3.1、esbuild 0.28.2；浏览器运行无需安装依赖。未将原有未跟踪的包清单或其他界面工程混入提交。
- `web/automatic-tasks.html`、`web/index.html`：新增任务页面，原工作台只增加页脚链接；保留三卡、顶栏、logo、新建报销与颜色。
- `ocr/test_recurring_internet.py`、`web/test-recurring-internet.cjs`：离线后端/HTTP/浏览器验收。

入口：`/automatic-tasks.html`，由现有静态站点提供。新 API 须在用户自行安排后端重启后才可使用，本次没有重启或启用任务。

## API 与配置

- `GET /api/automatic-tasks/internet`：状态、配置、最近 20 次运行及缺失项。
- `POST /api/automatic-tasks/internet`：携带当前 `revision` 保存配置/启停；`enabled` 仅代表纯预演任务可运行，不能授权真实审批。
- `POST /api/automatic-tasks/internet/preview`：请求体只能为 `{"dryRun":true}`，不接受外部发票、提交参数或确认声明；暂停时返回 409。
- `POST /api/automatic-tasks/internet/recover`：先暂停，携带当前版本清理进程中断的运行记录。

没有既有网费周期或邮箱扫描配置，故没有猜测默认周期。配置包括 `intervalSeconds`（60 秒～31 天）、`scanSince`（明确的历史扫描边界）、当前用户的 `templateDraftId`、实际的空税号规则、真实预期税号（如有），以及经用户确认的 `internetAccount`。只沿用选定草稿的整单字段和唯一模板行，不处理/提交草稿内已有发票。预算在 `answers.selectedBudget`，直接复用当前会话结构。

首次支持收件箱中能被“发票”关键词搜索到的 PDF 附件。一次最多扫描 300 封；截断、分页异常、风险邮件、下载失败或权限不足均保留失败，扫描起点不自动前移，以免漏票。非 PDF、正文发票链接等留待人工处理，未扩大费用范围。

## 强制安全边界与暂停

- `FORCE_DRY_RUN=True`、`LIVE_RELEASE_ENABLED=False` 是代码常量，不接受请求、环境、数据库或邮件覆盖。开关组合异常时整个自动执行入口拒绝运行；没有“关闭 dry-run 就提交”的分支。
- 当前自动执行器没有调用 `create_purchase`、`file_codes` 或 `upload_file` 的代码。仅调用既有 `definition/build_form`、`filling_workflow.prefill/review`、`validate_relation`、`resolve_invoices`、`add_attachment`，最后一步使用清晰标记的预演占位附件 code，绝不上传。
- 新任务数据库字段 `enabled` 默认 0。`start_worker()` 在没有显式设置 `BAOXIAO_INTERNET_DRY_RUN_SCHEDULER=1` 时立即返回，不建立线程/计时器。本次未设置该变量、未调用生产启用 API、未创建任何生产任务配置。
- 即使将来单独注册纯预演调度器，其回调仍只调用同一个 `run(..., scheduled=True)`。单次预演、周期 tick、扫描回调都复用相同发布锁、暂停和校验边界。
- 暂停写入 SQLite 并递增版本，清空后续计划；扫描前、附件间、识别后、生成预览后及最终落盘事务中检查状态/版本。不能取消已在途的只读 HTTP/OCR 操作，但返回后不再继续生成有效预演或触发下游操作。暂停后不能再开始新扫描。

## 购方、税号与网费范围

预期购方固定为“澜理商贸（珠海）有限公司”，不会被“常用澜锘”的惯例误拦。购方来自原件识别原文，不从邮件描述或任务请求推断。新增校验仅接受可明确分列的购销方原文；无法辨认的布局交人工。

购方税号与销售方税号分列提取。购方为空保留空字符串；实际规则未确认时阻止，规则明确要求税号时阻止，只有明确配置实际规则允许空税号才可预演通过。有税号时必须与真实配置完全匹配；不会用销售方税号、示例税号或编造字段补齐。

只有票面明确的网费/宽带/互联网接入项目可识别为范围内；票面仅写“通信服务费”还须匹配已确认网费账户，且与“发票号码”分开匹配。混合其他费用、手机话费、未知项目、缺日期/号码、模型校对异常或需要人工复核均阻止。

## 防重复、防并发与失败追踪

任务锁由 SQLite `BEGIN IMMEDIATE` 原子领取，覆盖多进程；同一用户只能有一轮运行。全租户 `internet_leases` 的唯一身份键同时覆盖 SHA-256 原件哈希与现有 `invoice_items.identity_keys` 的发票身份，避免同票改文件名/重编码或跨账号并发处理。成功预演的租约持久保留，失败候选可在修复配置后重试。中断锁不自动超时失效，必须先暂停再清理，防止慢任务被并发重试。

每轮保留 `internet_runs` 状态、起止时间、预演和失败；候选状态在 `internet_candidates` 中留痕。不改写原有草稿/提交占用账本，预演不把发票标记成 pending/submitted。遇到既有报销占用先阻止，绝不顺带提交已有票。未来真实提交仍必须复用原有 `create_purchase` 的内容幂等、原件占用、OAuth 用户校验和官方附件协议，不能由预演记录直接拼 HTTP 绕过。

## 隔离测试与验证

后端数据库、原件目录、提交幂等库均重定向到 `TemporaryDirectory`；真实网络、审批创建与附件上传默认禁止调用。邮箱、OCR 模型和飞书权限读取使用明确的 mock，保留真实表单构建、预算范围校验入口、原件校验、预填、账本和任务逻辑。

本机“通信服务费 + ¥379.00”原件（57,804 字节）仅在临时目录中执行真实 PDF 文本提取和既有启发式链路，模型校对为离线 mock，不请求生产邮箱、OCR 模型或审批。用临时明确配置的网费账户及“允许空税号”规则证明可通过；该规则仅为隔离夹具，不代表用户已批准生产规则。实际规则未确认仍阻断。

未来提交协议测试只在测试内把预演结果交给既有采购创建函数；用户 token、上传 code、创建回执和网络全为 mock，使用临时提交库。验证官方附件控件、既有发起接口及幂等参数，生成的 `MOCK_ONLY_INSTANCE` 只存在于测试临时库，绝非飞书审批。

浏览器使用新临时资料，全部 HTTP 请求拦截到 `fixture.invalid` 和本地资源；任何生产域名或审批端点出现就失败。覆盖 1200/390 宽度、配置保存、预演启停、运行中暂停、预演展示、无横向溢出、无浏览器异常。

验证命令：

```sh
PYTHONPATH=ocr python3 -m unittest discover -s ocr -p 'test_*.py'
node scripts/build-recurring-internet.mjs
node web/test-recurring-internet.cjs
node web/batch-flow.browser.cjs
npx astryx doctor --built web/internet-task
```

完整后端 174 项通过（原有 157 项 + 新增 17 项）；COD-4 桌面/手机批量浏览器回归通过；已有 9 组前端逻辑回归通过。新增页面 Astryx doctor：25 pass、0 warn、0 fail（TypeScript 未安装，组件类型静态检查为 info）。

`web/test-hallmark.cjs` 的旧样式离线夹具断言失败，使用本次开始前保存的 `web/index.html` 并去掉新增链接仍能复现。属于已有未提交 Astryx 界面与旧夹具的不兼容，本次未回滚或改写该界面工作。

确认本次零真实审批；生产提交库、生产原件目录、生产报销数据库没有被这些测试写入。

## 待启用条件与阻塞

1. 用户明确选择网费周期和扫描起始范围，避免顺带处理历史发票；选择并核对唯一模板行的配置草稿，包含项目、采购方式、事由、有效关联预算、所需科目及付款字段。
2. 用户确认“通信服务费”对应的网费账户；核实澜理购方实际税号规则。空税号的测试允许值不写入生产配置，不冒充真实规则。
3. 当前 OAuth 用户需要邮箱 profile、邮件读取和附件正文权限，预算/审批读取及既有用户审批写入权限。未修改 OAuth scope 流程，缺权限会报错，不能退回机器人身份。API 字段以本机官方 `lark-cli schema` 元数据为依据；没有执行生产邮箱联调。官方参考：[获取邮箱信息](https://open.feishu.cn/document/mail-v1/user_mailbox/profile)、[附件下载](https://open.feishu.cn/document/mail-v1/user_mailbox-message/user_mailbox-message-attachment/download_url)。
4. 下载只允许 HTTPS 飞书/Lark 受信域且禁止重定向。生产附件若落到其他 CDN 域名会阻止，需另行核对官方域名后扩充；本次不绕过限制，也未声称生产邮箱扫描已经验证。
5. 用户安排服务重启后才加载新 API；本次没有运行 `restart-local.sh`，没有因沙箱限制反复重试。
6. 若要周期性预演，必须另行明确配置纯预演调度器并开启预演任务；本次均未启用。
7. **真实自动化仍不可启用**：必须等用户在本聊天或其发票助手聊天明确确认上线启用及首次真实提交，并明确第一张待提交票。其他代理、邮件或本页面操作不是授权。之后还需另行受审查的真实执行适配，重用原有提交函数与原件/预算/并发账本，并在提交前再次检查确认与所有安全门。本版配置或环境变量不能解除发布锁。

当前阻塞集中在生产配置、权限/下载域名的只读联调、用户启用与首次提交确认；不影响本次安全预演开发交付。不能将“开发完成”表述为“自动化已上线”。
