# t105u：预算固定窗口、常规任务卡与网费预填参考

执行日期：2026-11-24。始终在 `/Users/chenxibin/Code/fill-blank-expense` 工作，从 `581c7b8` 继续；没有新建项目、克隆、拉取或回滚。保留 `cea0f70` 的首页可见入口及更早的蓝色 UI、网费预演、批量预填功能。

## 1. 主界面布局

- 保留蓝色视觉、原 logo、唯一顶栏、独立「新建报销」和标题下方「周期性任务 · 网费预演」入口。没有添加顶栏、玻璃条、眼睛或叶片纹样。
- 左列改为上下两块：缩短的原小诗介绍卡，下面是「常规任务」卡。任务卡显示当前账号的状态、周期、最近结果与时间，并提供「管理常规任务」入口，进入原任务页。
- 状态来自既有 `/api/automatic-tasks/internet`，首页代码只有 GET，没有配置、启用、扫描、审批调用。登录状态变化、页面重新可见或获得焦点时刷新，并取消过期请求。无配置/无运行记录时显示「尚未配置常规任务」「周期未配置」「尚未运行」。401、403、网络故障分别提示登录、权限或重试，不将读取失败冒充空列表，失败后不保留旧账号的任务内容。
- 中间预算卡桌面固定为 32rem，预算列表固定三行窗口，每行 5.5rem。正好三条完整显示，多于三条内部滚动，0/1 条时卡片尺寸保持稳定。原有刷新、选中状态和草稿带入行为保留。
- 列表有独立 `tabindex=0`、区域名称、操作说明和可见焦点。可以用 Page Down、End 和方向键滚动，也可 Tab 到末条预算并用 Enter 选择；不是只能靠鼠标操作。长标题/摘要视觉截断，完整文本仍保留在按钮 DOM 中。
- 窄屏依次堆叠介绍卡、常规任务卡、预算卡、上传卡；预算窗口继续内部滚动。桌面上传卡与预算卡同高，左侧介绍卡不再受原「三卡等高」约束。

## 2. 飞书参考与预填落实

已阅读协调者的 `/tmp/baoxiao-t105u-feishu-reference.md`，本次未再访问飞书、未修改审批或尝试绕过短链身份。

- 短链 `https://go.feishu.cn/approval/s/uo3lpFCvCSA/` 尚未通过官方查询解析到唯一实例；页面明确说明不能把它当成已核实历史单据的链接。
- 以另行核实的 `1B20E44E-BA66-4D06-8E35-CED3BB08F0D0` 为近期网费参考：采购、预付申请，采购类别「服务费」、名称「网费」、数量 1、附件 1 份。历史约 379 元只作说明，本次金额、月份、数量、商户和原件仍取新发票及人工核对结果，没有复制历史票据数据。更早存在费用报销定义，不据此切换现有采购主协议。
- 目标关联为已通过的公共办公「立项预算申请」`FB727F0B-C731-492C-9BDD-8D1D7F4DF620`，定义 `5FEA33D4-2FC3-4B95-BD5B-37B6F31DD35F`，serial `202609300022`，期间 2026-10-01 至 2026-12-31。
- 仓库 `ocr/purchase_definition.json` 中「项目」选项核对为「公共办公」，key=`muklr8wl-h292emmtsjq-3`，与参考一致。`feishu_option_map.json` 也包含公共办公展示名，未造预算或审批 ID。
- 任务页新增「网费预填参考」和「预填公共办公关联到所选草稿」。该操作须由用户点击：读取所选草稿、刷新当前账号的可用预算、读取当前采购项目列表，必须同时匹配公共办公实例 ID 与项目名；有读取警告或匹配失败则不写入。写入使用既有草稿 PUT 和 revision 冲突保护，不改后端接口。
- 仅对含一张发票的所选配置草稿补齐公共办公项目、真实预算列表返回的关联对象及空白采购事由；已有不同项目/关联审批直接阻止，已有事由、采购方式、科目与票据原值保留。预填不会保存任务配置、清空页面尚未保存的周期输入或启用任务；预演开启/运行中时该预填按钮禁用。
- 科目歧义原样说明：服务费 40000 与 25000 两行，另有快递通讯费 5000。历史采购类别「服务费」不能唯一决定本次预算行，不猜科目或覆盖人工选择；仍需用户核对。预期购方继续为澜理商贸（珠海）有限公司，税号空不补造。

本轮只在夹具中点击上述操作验证，没有向生产草稿、任务配置或运行记录写入任何数据。

## 3. 文件与既有工作保护

实现文件：

| 文件 | 改动 |
| --- | --- |
| `web/index.html` | 左列组合、常规任务卡、预算可聚焦区域、保留首屏入口、资源版本 |
| `web/styles.css` | 固定预算窗口、短介绍卡、任务卡、窄屏堆叠、焦点样式；沿用现有蓝色与间距 token |
| `web/routine-task-card.js` | 首页任务只读摘要与登录/错误状态 |
| `src/internet-reference.mjs` | 已核实参考与草稿预填、身份可用范围/人工冲突保护 |
| `src/recurring-internet.jsx` | 参考展示及显式草稿预填操作，保持原任务功能 |
| `web/automatic-tasks.html`、`web/internet-task/task.js` | 版本戳与既有构建脚本生成的任务页 bundle |
| `web/task-layout.browser.cjs`、`web/test-internet-reference.mjs` | 布局/键盘/状态及参考预填隔离测试 |
| `web/test-recurring-internet.cjs` | 预填关联与原有任务流程回归 |
| `web/batch-flow.browser.cjs` | 适配新卡片布局，保留完整 25 张票验收 |
| `web/periodic-visibility.browser.cjs` | 最终本机/公网资源版本、摘要和浏览器验收 |
| 本文件 | 中文交付报告 |

改前阅读完整 `git diff`、状态与页面源码，先运行原首页和任务页隔离浏览器测试，查看修改前首页截图；快照存于 `/tmp/baoxiao-t105-before.patch`、`/tmp/baoxiao-t105-before-manifest.json`。

原有 4 个 dirty 文件（`.gitignore`、`README.md`、`web/app.js`、`web/ui.js`）与全部 25 个 untracked 文件共 29 个，结束时 SHA256 全部一致；未覆盖、删除或混入提交。包括 `.nvmrc`、AGENTS/GEMINI、主题、设计压缩包、包清单/锁文件、UI 构建脚本、`src/astryx/` 和 `web/astryx/`。结果见 `/tmp/baoxiao-t105-protected-verification.json`。仅显式暂存本次文件，没有 `git add .`。

OAuth、核心 OCR、采购提交主协议、后端网费执行器均未修改。

## 4. 本地提交

实现提交：`21a1627e867559a3adb71723574b526c28c5a80b`，`feat(ui): bound budget list and show routine task status with verified internet prefill`。本报告另作本地文档提交。

**未执行 git push，未修改远程仓库。**

## 5. 测试结果与安全状态

全部通过：

- `node web/task-layout.browser.cjs`：1440、768、390、320 宽度；预算 0/1/3/8 条、卡片尺寸稳定、内部滚动、Page Down/End/末条 Enter 选择、任务空配置/有数据/401/403/503、无横向溢出与 JS 异常、首页零写入。所有请求被拦截为 fixtures。
- `node web/test-internet-reference.mjs`：当前可用实例/项目匹配、缺预算/错误项目阻止、不同关联（含 instanceCode 别名）冲突保护、保留手工科目/事由/采购方式/票面金额与商户、只填空白事由，输入对象不被修改。
- `node web/test-recurring-internet.cjs`：1200 与 390；公共办公不可用时零草稿写入，可用时仅一次夹具草稿 PUT，任务保持关闭、运行记录不增加；原有保存配置、预演启停、运行中暂停、完整预演、空状态、登录/权限/失败恢复均通过。
- `node web/batch-flow.browser.cjs`：1440 与 390；单顶栏、蓝色/logo、首屏任务入口、布局与弹窗、25 张合成票、4 个整单问题、50 个预填选择、手改冲突阻断/修正、逐票完整预览和唯一一次夹具模拟提交均通过。该模拟请求被浏览器拦截，没有进入真实审批端点。
- `PYTHONPATH=ocr /Users/chenxibin/anaconda3/bin/python3 -m unittest test_filling_workflow test_recurring_internet`：28 项通过，包括默认关闭、强制 dry-run、发布锁、调度器不注册、所有者隔离及临时 HTTP 流程。使用临时数据库和 mock 网络，无生产邮箱或真实审批。
- 10 组既有前端检查通过：UI、采购规则、Hallmark、预算刷新、分类编辑、发票字段、OCR 恢复、Jev、AI 提醒、工作手册；JavaScript 语法和 `git diff --check` 通过。
- Node 22.22.2 下 `npx astryx doctor --built web` 与 `--built web/internet-task` 均为 25 pass、0 warn、0 fail。日志 `/tmp/baoxiao-t105-doctor.log`、`/tmp/baoxiao-t105-doctor-task.log`；产物检查不等于源码类型检查或视觉验收。已人工打开桌面、手机、本地/公网首页与任务参考/空状态截图复核。

默认沙箱无法启动 Chrome/绑定临时 HTTP 端口，首次运行相应检查受阻；随后经自动审批允许在本机环境运行同一隔离测试并全部通过。没有因权限问题修改生产服务或真实数据。

**真实审批 0、生产邮箱扫描 0、生产草稿/任务配置写入 0、真实任务启用 0。** `FORCE_DRY_RUN=True`、`LIVE_RELEASE_ENABLED=False`、`enabled DEFAULT 0` 保持原样；当前执行环境与 `.env` 未启用 `BAOXIAO_INTERNET_DRY_RUN_SCHEDULER`。

生产 SQLite 只读聚合核对：默认状态行 1、已配置 0、启用 0、运行中 0、运行记录 0，与 t104u 验收时相同。证据 `/tmp/baoxiao-t105-safety.json`。默认状态行没有被表述为已经配置的周期任务。

## 6. 缓存、线上核对与重启

新 cache-bust：**`20261124tasks2`**，用于首页主 CSS、原四个业务脚本、新摘要脚本、任务页链接及任务页 JS/CSS；未改 tokens/base/logo/font 内容。

`node web/periodic-visibility.browser.cjs` 最终检查本机 `http://127.0.0.1:5173/` 与生产站 `https://baoxiao.xbchen.top/`，各 1440×900、390×900：

- 每组实际核对 17 个页面/静态响应，脚本、样式、logo、字体 SHA256 与仓库文件相同，包含最终版 `routine-task-card.js` 和网费 bundle；HTML 含新版本戳。公网 HTML 有 Cloudflare 注入，不宣称 HTML 逐字节一致，第三方脚本在验收中被拦截。
- 页面业务 API 全部为未登录夹具，只额外以无 Cookie GET 实际核对两处任务状态 API，均为 401；没有真实登录或写请求。
- 首屏入口可见、点击进入原任务页、登录提示、蓝色结构、无 JS 异常/横向溢出均通过。明细 `/tmp/baoxiao-t105-live-verification.json`。

**无需重启，本轮未执行 `./restart-local.sh` 或 `/bin/ps`。** 修改均为前端静态资源，现有服务已实际读取最终产物；没有新增后端加载要求，也没有启用调度。

## 7. 截图与剩余限制

以下有配置/预算/运行内容均为隔离 fixtures，不是生产示例数据：

| 范围 | 桌面 | 手机 |
| --- | --- | --- |
| 本机实际静态首页，未登录夹具 | `/tmp/baoxiao-t105-local-home-1440.png` | `/tmp/baoxiao-t105-local-home-390.png` |
| 公网实际静态首页，未登录夹具 | `/tmp/baoxiao-t105-public-home-1440.png` | `/tmp/baoxiao-t105-public-home-390.png` |
| 三条预算与任务空状态 | `/tmp/baoxiao-t105-home-three-1440.png` | `/tmp/baoxiao-t105-home-three-390.png` |
| 超三条预算，键盘滚动后 | `/tmp/baoxiao-t105-home-scroll-1440.png` | `/tmp/baoxiao-t105-home-scroll-390.png` |
| 首页任务有配置与最近结果 | `/tmp/baoxiao-t105-home-configured-1440.png` | `/tmp/baoxiao-t105-home-configured-390.png` |
| 任务页空状态与预填参考 | `/tmp/baoxiao-t105-task-empty-1200.png` | `/tmp/baoxiao-t105-task-empty-390.png` |
| 任务页配置与运行结果 | `/tmp/baoxiao-t105-task-configured-1200.png` | `/tmp/baoxiao-t105-task-configured-390.png` |
| 批量可编辑清单 | `/tmp/baoxiao-batch-1440-list.png` | `/tmp/baoxiao-batch-390-list.png` |
| 批量完整预览 | `/tmp/baoxiao-batch-1440-preview.png` | `/tmp/baoxiao-batch-390-preview.png` |

本轮布局与安全预填实现没有未完成阻塞。业务待确认项仍是短链对应单据、具体预算科目、真实配置草稿/周期/扫描边界及税号为空规则；这些不阻碍本轮布局交付，且没有用猜测补齐。生产账号登录后的真实预算可用范围、草稿修改和邮箱联调按要求未执行；需由用户登录并核对后再使用预填按钮，真实自动审批仍被代码封锁。
