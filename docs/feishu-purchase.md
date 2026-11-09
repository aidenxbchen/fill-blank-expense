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
发票原文件上传暂未实现（定义中的「附件」为选填）；无票草稿占位行不自动发起，mock 识别结果也禁止真实提交。

## 防重复与失败

提交中禁用按钮；后端生成内容稳定 UUID，成功后相同内容仅重放真实回执。
服务端 `.submissions.sqlite3` 用用户与规范化表单内容生成 UUID 并持久化：成功可重放，相同内容并发只允许一次 POST。
网络失败 / 5xx / 缺少实例 Code / UUID 冲突均视为结果未确认，不自动再 POST。应先核对飞书「我发起的」，由管理员核实结果后处置 pending 记录，不能直接清库重试。
显式业务拒绝可在修正或重新授权后用同一 UUID 重试。

## 部署与复测

```bash
cd ~/Code/fill-blank-expense
git pull --ff-only origin main
python3 -m unittest discover -s ocr -v
python3 ocr/test_invoice_extract.py
./restart-local.sh
```

脚本只停止端口 18790 / 5173 上命令路径属于此仓库的服务，发现其他进程则报错中止。`--managed` 保持前台监督进程，供 Turnstone 持续运行服务使用。

1. 公网用飞书登录；旧会话缺写权限时退出重新授权。
2. 硬刷新 https://baoxiao.xbchen.top ，确认提交页无 stub 提示。
3. 上传真实发票，在识别汇总表修改一个金额 / 商户 / 发票号；完成问答，选择已通过的预算。
4. 逐句问答选择「个人垫付」、真实项目，补全科目、规格、数量；草稿可展开采购明细修改。留空必填项应阻止提交并返回问答。
5. 发起后核对真实 `instanceCode`，点击飞书返回的链接，并在飞书「我发起的」查看申请人、采购方式、项目、关联审批、金额和备注中的发票号码。
6. 重复点击 / 刷新后重试同样内容，不应出现第二条审批；断网与撤销写 scope 均只能显示失败。
7. 切换七种采购方式，检查仅对应明细出现；预付款不要求关联，其余缺关联 / 使用未通过或错误类型实例应失败。

自动测试不创建真实审批。浏览器回归使用受控响应测试成功 / 权限拒绝 / 断网 / stub 拒绝，不等同于生产 OAuth 创建成功。
