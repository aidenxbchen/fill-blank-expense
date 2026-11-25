> 发布范围更新（t113u）：本文件部门部分为历史研究，部门选择暂缓。travel-only 发布不提供部门控件、不增加部门读取权限，也不增加多部门提交锁；保持原生产部门行为。差旅读取协议依据仍适用。

# COD-8 飞书官方接口证据（2026-11-25）

本文件只记录公开官方规范。未调用业务写接口、未访问浏览器、未携带任何用户凭据。API Explorer 的公开定义 JSON 保存在 /tmp/cod8-official-*-definition.json。公开官方旧版 Markdown 索引不包含若干新 OAuth 接口，以 Explorer 元数据补充核实；不要将旧 tenant-only API 的字段套到新接口。

## 1. OAuth 发起部门字段：阻塞已确认

- [官方 API Explorer：initiate](https://open.feishu.cn/api-explorer?apiName=initiate&project=approval&resource=instance&version=v4)
- [公开官方 JSON 规范](https://open.feishu.cn/api_explorer/v1/api_definition?project=approval&version=v4&resource=instance&apiName=initiate)
- `POST /open-apis/approval/v4/instances/initiate`，`accessTokens: ["user"]`，scope `approval:instance:write`。
- 请求体公开属性**只有** `approval_code`, `form`, `node_approver_list`, `node_cc_list`, `uuid`；没有 `department_id`、`department_id_type`，也没有 query 定义。
- 因此：当前官方公开规范不足以支持“OAuth initiate 显式指定部门”。不能仅向请求体塞入旧字段并宣称生效，不能拿 mock 成功当真机支持证据。多部门用户在该能力得到飞书官方确认前应阻止正式发起，给出明确原因；真实部门选择、草稿、预览可以实现。
- [旧创建审批实例文档](https://open.feishu.cn/document/server-docs/approval-v4/instance/create.md) 的 `POST /approval/v4/instances` 为 **tenant_access_token**，才公开 `department_id`。该字段要求 **department_id 类型**，不支持根部门；多部门未传时默认部门列表第一项。用户明确要求保留 OAuth initiate 主协议，不可为支持部门静默改用旧接口。

## 2. 当前 OAuth 用户真实部门及名称

- [获取单个用户](https://open.feishu.cn/document/server-docs/contact-v3/user/get.md)：`GET /contact/v3/users/:user_id` 支持 user_access_token 与 tenant_access_token。
- 使用 `:user_id = 当前已重新核验 OAuth actor.openId`，显式 `user_id_type=open_id&department_id_type=department_id`。
- `department_ids` 为完整所属部门 ID 数组，一个用户可有多个部门；字段权限 `contact:user.department:readonly`（或文档列出的较宽通讯录权限之一）。基础 API 权限 `contact:contact.base:readonly` 等选一。缺字段不能视作没有部门，应报字段权限不足。
- [获取单个部门](https://open.feishu.cn/document/server-docs/contact-v3/department/get.md)：`GET /contact/v3/departments/:department_id?department_id_type=department_id` 支持 user_access_token。`name` / `department_id` 的字段权限 `contact:department.base:readonly`（或较宽通讯录权限之一）。用户必须具有该部门的组织架构可见性。
- `department_id` 和 `open_department_id` 是不同标识，后者以 od- 开头；明确请求前者以便未来与正式部门字段一致。不能从旧审批记录反推当前部门，也不能按陈/刘姓名硬编码。

## 3. OAuth 出差候选读取：有官方支持路径

### 已发起

- [官方 Explorer initiated](https://open.feishu.cn/api-explorer?apiName=initiated&project=approval&resource=instance&version=v4)
- [公开 JSON](https://open.feishu.cn/api_explorer/v1/api_definition?project=approval&version=v4&resource=instance&apiName=initiated)
- `GET /approval/v4/instances/initiated`，user token，scope `approval:instance:read`。
- 定义过滤参数为 **definition_code**，应传 `87FAB2C0-D271-4ACF-9344-E7608532FA5C`，不是 budget 定义也不是 approval_code 参数。
- 支持 page_size/page_token/locale/user_id_type；start_timestamp/end_timestamp 为秒级发起时间，**不是出行时间**。
- 响应 `data.instances`；`instance_status="2"` 代表通过；字段 `definition_code`, `definition_name`, `initiator`, `initiator_name`, `instance_code`, `summaries`。分页必须穷尽，不可用 count=99 作为总量。

### 待办、已办、抄送、已发起（完整原生关联参与范围）

- [官方任务查询文档](https://open.feishu.cn/document/server-docs/approval-v4/approval-search/query.md)
- [公开 JSON](https://open.feishu.cn/api_explorer/v1/api_definition?project=approval&version=v4&resource=task&apiName=query)
- `GET /approval/v4/tasks/query` 支持 **user** 与 tenant；当前公开 JSON scopes `approval:approval:readonly`, `approval:task:list_by_user`（文档旧版仅列前者，具体 token 支持依官方返回 scope）。
- query：`user_id=网页当前actor.openId`, `user_id_type=open_id`, `topic=1|2|3|17|18` 分别为待办、已办、已发起、未读抄送、已读抄送，支持分页。
- 响应 `data.tasks`；`definition_code` 可过滤真实出差定义；`process_code` 为实例 Code；`process_status="2"` 代表通过；也有 initiators / initiator_names。
- 可汇总上述 topic 后按 instance code 去重，再读 OAuth detail；这样原生待办/已办/抄送参与不依赖预算“项目参与人员”字段。接口缺 scope 必须明确报权限不足，不能把无法读取当空列表。

### OAuth 详情

- [官方 Explorer detail](https://open.feishu.cn/api-explorer?apiName=detail&project=approval&resource=instance&version=v4)
- [公开 JSON](https://open.feishu.cn/api_explorer/v1/api_definition?project=approval&version=v4&resource=instance&apiName=detail)
- `GET /approval/v4/instances/detail?instance_code=...&locale=zh-CN&user_id_type=open_id`，user token，scope `approval:instance:read`。
- 返回 `definition_code`, `definition_name`, `user_id`, `status`, `form`, `tasks`, `comments`, `operation_records`, `reverted`。适配成现内部结构时须显式映射；`status="APPROVED"` 与列表数字状态不同。
- [旧实例详情](https://open.feishu.cn/document/server-docs/approval-v4/instance/get.md) `GET /instances/:instance_id` 只支持 tenant，不可把 user token 塞给旧 fetch_instance。
- [旧 instances/query](https://open.feishu.cn/document/server-docs/approval-v4/approval-search/query-2.md) POST 仅 tenant，scope approval:approval.list:readonly；会过滤撤销实例且有索引延迟。不是 OAuth 替代方案。

## 4. 原生关联控件规则

- [官方产品说明：管理员使用关联审批控件](https://www.feishu.cn/hc/zh-CN/articles/896720801778-管理员使用关联审批控件)：支持关联待办、已办、抄送我、已发起；允许按主题、申请人、编号、内容搜索；一个控件最多 100 单。
- 产品默认允许任意状态，管理员可开启“仅已通过”和“限定可选审批定义”。所以“飞书永远只许已通过”不是通用规范；报了呗保留已通过作为业务规则可以，但需要写明。
- [官方定义控件参数](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/approval-v4/approval/approval-definition-form-control-parameters.md)：connect 的 `value` 在**定义**中为可关联**审批定义 Code 数组**。
- [官方实例控件参数](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/approval-v4/instance/approval-instance-form-control-parameters.md)：connect 的 `value` 在**实例**中为关联**实例 Code 数组**，不可混淆两者，也不可由 AI 生成实例 Code。
- 公开定义控件文档没有给“仅已通过”的机器字段名。必须检查实际实时 schema 的 connect 数据；未拿到真实 schema 时不能声称核验了当前采购定义该设置。可复核定义 value 范围，并通过真实 OAuth 可见性、APPROVED、reverted=False 约束安全筛选。

## 5. 尚未验证

- 当前网页用户真实深圳申请是否存在于已发起/待办/已办/抄送范围，以及实际实时采购 schema connect 选项与状态限制，需授权网页用户只读联调；CLI 身份不能代替网页 actor。
- OAuth initiate 显式部门支持尚无官方依据，是多部门正式发起的硬阻塞，不应部署为已完成功能。
