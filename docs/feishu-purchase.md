# 飞书采购申请接入

2026-11-09：通过飞书用户身份查询核实原生「采购申请」，定义 Code
`D448D0FB-77DB-4640-9650-1FB99512888C`，非三方审批。
`ocr/purchase_definition.json` 是不含人员 / 节点信息的回归测试快照；运行时每次从飞书读取当前定义，不用静态快照冒充实时数据。

## 接口与身份

- 实时读定义：`GET /open-apis/approval/v4/approvals/{approval_code}?locale=zh-CN`，使用已有 tenant 只读权限。
- 真实发起：`POST /open-apis/approval/v4/instances/initiate`，仅使用当前会话 `user_access_token`。服务端先刷新会话并校验 OAuth 用户身份，忽略客户端提供的申请人。
- 创建请求为 `{approval_code, form: JSON.stringify(controls), uuid}`；只有 `code=0` 且返回非空 `instance_code` 才成功。优先展示飞书返回的 `instance_link`，并读取真实单号；没有链接时以真实 code 构造飞书审批 App Link。
- 关联实例通过已有应用只读权限读取，重新验证状态、允许的审批类型和当前用户参与范围（沿用预算 open_id / user_id 别名匹配）。
- [用户发起接口](https://open.feishu.cn/api-explorer?apiName=initiate&project=approval&resource=instance&version=v4)。旧 `/instances` 是 tenant-only，不用于本实现。

## 权限与实测

目标应用 `cli_aaa28a16ca785cba` 发起需要**用户身份** `approval:instance:write`。OAuth scope 自动补齐它，旧用户缺授权时需退出重新登录。读取定义与预算继续复用已开通的应用只读权限，不要求新增用户 `approval:approval:read` 或应用写权限。

2026-11-09 在部署机器核验目标 App：当前会话有 `approval:instance:write`，`/instances/initiate` 的不存在定义探测返回 `1390001 approval code not found`，已通过认证和权限门槛。实时定义读取成功；真实定义的流程预览（指定现有部门）返回 code 0。未发起测试采购，最终成功单据需用实际发票复测。用户定义 `/detail` 的 `approval:approval:read` 当前未授予，本实现不使用该端点。

缺权限显示飞书错误和 [用户写权限开通链接](https://open.feishu.cn/app/cli_aaa28a16ca785cba/auth?q=approval:instance:write&op_from=openapi&token_type=user)，失败不得显示成功。

## 字段映射

| 来源 | 飞书控件 |
|---|---|
| 逐句问答 / 草稿采购方式 | `widget17903948934810001` / `radioV2`（使用选项 value） |
| 逐句问答 / 草稿项目 | `widget17902350031990001` / `radioV2`（从定义选项明确选择） |
| 已确认采购事由 | `widget16510608596030001` / `textarea` |
| 当前可编辑识别汇总表逐行 | 当前采购方式对应 `fieldList`，二维控件数组 |
| 汇总表商户（或文件名） | 明细「名称」，不用旧 OCR 原值 |
| 汇总表金额 | 明细「金额」，数字 + `currency: CNY`，后端验证每行正数、精度两位 |
| 汇总表日期 / 商户 / 发票号 | 明细「备注」，保留发票事实 |
| 用户补全的科目、规格、数量、账户等 | 实时定义中相应子控件 ID；没有内容则阻止提交，不猜测 |
| 选择的预算实例 Code | `widget17901536351250001` / `connect`，值为 `[instance_code]` |

| 采购方式 | 明细表 ID |
|---|---|
| 个人垫付 | `widget17903992963450001` |
| 预付款项 | `widget17903992006220001` |
| 合同审批 | `widget16510609006710001` |
| 淘宝平台 | `widget17903993849130001` |
| 京东工品汇 | `widget17903993847270001` |
| 差旅费 | `widget17904065904320001` |
| 嘉立创平台 | `widget17918709994970001` |

仅提交当前可见的一张明细表。合同 / 预付款需账户及银行信息，京东需采购清单，差旅需费用类型。所有选项取实时定义的值，新增未知必填字段或自选审批人会明确报错。

关联实例服务端读取验证：必须在当前用户可见范围，状态为 APPROVED，且定义为以下之一：

- 立项：`5FEA33D4-2FC3-4B95-BD5B-37B6F31DD35F`
- 变更：`9BACB334-4059-4DB2-AC98-A56587B0F150`
- 出差：`87FAB2C0-D271-4ACF-9344-E7608532FA5C`

预付款项不提交关联控件；其他方式必填。不用项目标题或 definition Code 冒充 instance Code。
本产品要求每张票有原文件，即使飞书定义将「附件」设为选填。无原文件、原件属于其他用户、原件损坏、模拟发票均阻止真实发起；旧会话需在识别汇总点「补传原件」，不覆盖手改事实。

## 发票附件

1. 登录后上传 PDF / 图片，原始字节先保存在 Mini `.invoice-files/`，即使 OCR 失败也返回原件引用供手工修正。目录 0700、文件与数据库 0600；每文件最多 24MB，文件名不作为本地路径。
2. 提交前服务端按 OAuth `open_id` 校验文件归属和 SHA-256，所有发票必须有原件；客户端不能传任意路径、URL 或伪造远端附件 code。
3. 调用 `POST https://www.feishu.cn/approval/openapi/v2/file/upload`，multipart 字段为 `name`、`type=attachment`、`content`，使用同一应用 tenant 凭证。返回 `data.code` 是审批原生附件标识，不能用 Drive token 或下载 URL 替代。
4. 将 code 数组放入 `widget16510609389860001` / `attachmentV2` / `value`，再用当前用户 OAuth 调用 `/instances/initiate`。上传身份不改变审批申请人。
5. 上传失败或缺权限时不调用 initiate；返回真实错误与相应身份的权限开通链接。成功后读取审批详情确认附件数量，UI 显示数量及确认状态。
6. 本轮实测：真实 62,592 字节 PDF 和 PNG 图片上传成功；两份原生附件 code 一起写入采购申请后，流程预览 `code=0`。未新增生产采购。v4 上传接口会拒绝用户 token，且目标应用缺 `approval:instance.file`；本实现使用已实测可用的正式 v2 上传接口与现有审批读取权限。

接口参考：[飞书上传审批文件](https://open.feishu.cn/document/server-docs/approval-v4/file/upload-files)。

## 项目问答与本地建议库

发票只以「项目名称 + 金额」指代。整单信息一次收集；科目、差旅费用类型等逐票字段直接预填到可编辑清单，不进入问答队列。

`ocr/filling_workflow.py` 读取根目录 `报了呗.md` 的 `baoxiao-prefill-rules` 规则块。先应用差旅硬规则，再按本次用途和票面内容匹配合格历史，最后参考手册有条件建议。所有值须存在于当前飞书定义；用户已有值（含空值）不被后来的建议覆盖。硬规则冲突在预览与真实提交前校验，集中提示修改。

SQLite `.expense-data.sqlite3`（Git 忽略，0600）新增：

- `workflow_prefills`：按用户与草稿存服务端生成基线，同一采购方式重新整理不会擦除原始基线。
- `workflow_learning`：保存成功提交的最终版、基线与差异；`verified=0` 仅是待核验证据，不能进入正样本。历史导入的样本没有生成基线，不伪造修改差异。
- 旧 `fill_observations` 保留作审计，生产建议接口已停止使用未核验草稿作为正样本。

后台每分钟核验待学习单；整理清单时也后台导入当前登录发起人的历史（最多每小时一次）。准入要求：Asia/Shanghai 发起月与整体通过月均为 2026 年 11 月、整体已通过，且 connect 实际关联了详情可读取且已通过的立项预算或项目预算变更。只关联出差、审批中、撤回、拒绝、其他月份均不纳入。先检查准入，才读取费用内容。

每张不同审批只计一个支持。同用途、同票面类型、同采购方式至少三单的最终选择一致，才将聚合建议写入手册 `learned` 区；后续出现冲突即撤下建议。手册差旅硬规则不会被自动学习改写。单个历史建议仍标注待检查；模板不复制项目、用途、行程、关联或金额。Markdown 使用原子替换，核验后写入中断会在下次同步修复。

接口均要求登录：`POST /api/prefill` 生成并保存基线；`POST /api/review` 只读校验表单与本地原件，不上传附件、不创建审批。兼容的 `/api/fill-history` 与 `/api/fill-suggestions` 均只返回合格历史建议。提交协议和附件上传路径保持原样。

## 防重复与失败

提交中禁用按钮；后端生成内容稳定 UUID，成功后相同内容仅重放真实回执。
服务端 `.submissions.sqlite3` 用用户与规范化表单内容、原件 SHA-256 和文件名生成 UUID 并持久化：成功可重放，相同内容并发只允许一次 POST。
网络失败 / 5xx / 缺少实例 Code / UUID 冲突均视为结果未确认，不自动再 POST。应先核对飞书「我发起的」，由管理员核实结果后处置 pending 记录，不能直接清库重试。
显式业务拒绝可在修正或重新授权后用同一 UUID 重试。

## 部署与复测

```bash
cd ~/Code/fill-blank-expense
python3 -m unittest discover -s ocr -v
python3 ocr/test_invoice_extract.py
./restart-local.sh
```

脚本只停止端口 18790 / 5173 上命令路径属于此仓库的服务，发现其他进程则报错中止。`--managed` 保持前台监督进程，供 Turnstone 持续运行服务使用。

1. 公网用飞书登录；旧会话缺写权限时退出重新授权。
2. 硬刷新 https://baoxiao.xbchen.top ，确认提交页无 stub 提示。
3. 上传真实 PDF 和图片，在识别汇总确认「原件已保存」，修改一个金额 / 商户 / 发票号。旧草稿缺原件时补传，确认手改数据保持不变。
4. 一次补充整单用途、采购方式、项目与关联预算，在预填清单直接检查科目、费用类型及其余必填项。预览里留空、缺原件或手册冲突均阻止发起，返回清单集中处理。
5. 发起后核对真实 `instanceCode`，在本人飞书「我发起的」查看申请人与汇总事实，并在「附件」打开每份 PDF / 图片。页面显示附件个数和确认状态。
6. 重复点击 / 刷新后重试同样内容，不应出现第二条审批；断网与撤销写 scope 均只能显示失败。
7. 切换七种采购方式检查条件明细；25 张票不增加逐票选择题。用合格历史夹具验证同用途同类预填、保留手改、审批后差异学习和手册更新。无合格历史时明确标注待检查。

自动测试不创建真实审批。浏览器回归使用受控响应测试成功 / 权限拒绝 / 断网 / stub 拒绝，不等同于生产 OAuth 创建成功。

批量流程浏览器夹具：`node web/batch-flow.browser.cjs`（需可解析 Playwright；可用 `NODE_PATH` 指向本机已安装依赖）。桌面和手机宽度均测试 25 张批量上传、四项整单回答、五十个逐票预填字段、预览冲突保留与纠正，以及一次模拟提交；所有网络路由被拦截，不发起生产审批。
