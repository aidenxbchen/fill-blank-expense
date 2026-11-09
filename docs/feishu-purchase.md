# 飞书采购申请接入

2026-11-09：通过飞书用户身份查询核实原生「采购申请」，定义 Code
`D448D0FB-77DB-4640-9650-1FB99512888C`，非三方审批。
`ocr/purchase_definition.json` 是不含人员 / 节点信息的回归测试快照；运行时每次从飞书读取当前定义，不用静态快照冒充实时数据。

## 接口与身份

- 读定义：`GET /open-apis/approval/v4/approvals/{approval_code}/detail?locale=zh-CN`
- 发起：`POST /open-apis/approval/v4/instances/initiate`
- 查关联实例：`GET /open-apis/approval/v4/instances/detail?instance_code={code}`
- 三者均使用当前会话 `user_access_token`，沿用现有刷新机制。创建请求不接受客户端指定申请人，不用 tenant token 代提交。
- 请求为 `{approval_code, form: JSON.stringify(controls), uuid}`；只有 `code=0` 且返回非空 `instance_code` 才记成功。原样返回飞书给出的 `instance_link`，不伪造链接；没有链接时显示实例 Code。
- [发起接口](https://open.feishu.cn/api-explorer?apiName=initiate&project=approval&resource=instance&version=v4)、[定义详情](https://open.feishu.cn/api-explorer?apiName=detail&project=approval&resource=approval&version=v4)。接口路径和权限还经本机飞书 CLI schema / dry-run 核实。

## 权限

目标应用 `cli_aaa28a16ca785cba` 需要管理员开通并发布下列**用户身份**权限：

- `approval:approval:read`：读取当前审批定义。
- `approval:instance:write`：发起审批实例。
- `approval:instance:read`：验证关联审批 / 现有实例读取。
- 原登录权限：`offline_access auth:user.id:read contact:user.base:readonly`。

已有**应用身份**预算查询继续使用 `approval:approval.list:readonly` 和 `approval:approval:readonly`，不与用户写权限混用。
修改权限并发布版本后，旧会话需要退出再登录，重新同意授权。代码会合并三个审批用户 scope，即使 `.env` 中残留旧 `FEISHU_SCOPES` 也不会漏掉。缺权限返回 HTTP 403 与所需 scope；不显示成功。

本轮没有生产 `.env`，因此目标 App 的 scope 是否已经开通 / 发布尚未核实。CLI 读取定义使用的是本机已有的另一个已授权 App，不能据此推断目标 App 权限。

## 字段映射

| 来源 | 飞书控件 |
|---|---|
| 提交页采购方式 | `widget17903948934810001` / `radioV2`（使用选项 value） |
| 提交页项目 | `widget17902350031990001` / `radioV2`（从定义选项明确选择） |
| 已确认采购事由 | `widget16510608596030001` / `textarea` |
| 当前可编辑识别汇总表逐行 | 当前采购方式对应 `fieldList`，二维控件数组 |
| 汇总表商户（或文件名） | 明细「名称」，不用旧 OCR 原值 |
| 汇总表金额 | 明细「金额」，数字 + `currency: CNY`，服务端逐行验算总额 |
| 汇总表日期 / 商户 / 发票号 | 明细「备注」，保留发票事实 |
| 用户补全的科目、规格、数量、账户等 | 实时定义中相应子控件 ID；没有内容则阻止提交，不猜测 |
| 选择的预算实例 Code / 手工填写出差实例 Code | `widget17901536351250001` / `connect`，值为 `[instance_code]` |

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

前端保存同一内容的稳定 UUID，提交中禁用按钮，成功后再次点击仅重显结果。
服务端 `.purchase-submissions.sqlite3` 按登录用户 + UUID 持久化：成功可重放；同一 UUID 不同内容拒绝；并发只允许一次 POST。
网络失败 / 5xx / 缺少实例 Code / UUID 冲突均视为结果未确认，不自动再 POST。应先核对飞书「我发起的」，由管理员核实结果后处置 pending 记录，不能直接清库重试。
显式业务拒绝可在修正或重新授权后用同一 UUID 重试。

## 部署与复测

```bash
cd ~/Code/fill-blank-expense
git pull --ff-only origin main
python3 -m unittest discover -s ocr -v
python3 ocr/test_invoice_extract.py
./restart-local.sh --restart
```

`--restart` 只停止端口 18790 / 5173 上命令路径属于此仓库的服务，发现其他进程则报错中止。原不带参数方式仍只启动未运行的服务。

1. 为目标 App 开通上述用户权限并发布；公网退出后重新飞书登录。
2. 硬刷新 https://baoxiao.xbchen.top ，确认提交页无 stub 提示。
3. 上传真实发票，在识别汇总表修改一个金额 / 商户 / 发票号；完成问答，选择已通过的预算。
4. 提交页选择「个人垫付」、真实项目，补全科目、规格、数量。留空任何必填项应不能提交。
5. 发起后核对真实 `instanceCode`，点击飞书返回的链接，并在飞书「我发起的」查看申请人、采购方式、项目、关联审批、金额和备注中的发票号码。
6. 重复点击 / 刷新后重试同样内容，不应出现第二条审批；断网与撤销写 scope 均只能显示失败。
7. 切换七种采购方式，检查仅对应明细出现；预付款不要求关联，其余缺关联 / 使用未通过或错误类型实例应失败。

自动测试不创建真实审批。浏览器回归使用受控响应测试成功 / 权限拒绝 / 断网 / stub 拒绝，不等同于生产 OAuth 创建成功。
