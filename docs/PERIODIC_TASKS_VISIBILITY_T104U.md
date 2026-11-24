# t104u：周期性任务入口与列表可见性修正

执行日期：2026-11-24。工作目录始终为 `/Users/chenxibin/Code/fill-blank-expense`；没有另建项目、克隆、拉取、push 或修改远程仓库。

## 1. 根因核查

- **入口没有被蓝色恢复覆盖，而是原本只放在页脚，名称不易识别。** 对比 `d079880`、`9f7d4c9` 和开始时的 HEAD `6231baf`：首页一直只有页脚的「常规网费自动任务」链接，指向 `automatic-tasks.html`。`9f7d4c9` 恢复蓝色资源入口、更新缓存戳，没有删除该链接；`6231baf` 仅记录文档。本次开始时独立获取本机和公网 `?v=20261124blue1` HTML，均确认上述事实，主界面没有「周期性」文案。
- **任务数据必须登录后才能读取。** 本机 `:18790/api/automatic-tasks/internet` 和公网同路径的无 Cookie GET 都返回 401，错误为「请先登录飞书并确认读取权限」。原任务页只有通用错误和重新加载按钮；任务详情包在 `task && …` 中，读取失败时不会展示列表或配置，缺少明确的登录入口和状态解释。
- **当前确实没有已保存的周期配置或运行记录。** 对本机现用 `.expense-data.sqlite3` 以 SQLite `mode=ro` 查询聚合统计：`internet_tasks` 有 1 条默认状态行，`enabled=0`、配置为 `{}`、没有运行中的任务；`internet_runs` 为 0 条。默认状态行不能表述为已经配置的周期任务。未获取账号身份或读取敏感配置内容。
- **没有发现任务页静态资源失效或布局崩坏。** 原页已有运行状态、扫描周期、最近结果等详情，但没有清晰的任务列表与首次配置空状态；问题集中在发现入口、命名和读取失败/未配置的解释。登录后真实账号的浏览器数据读取未执行，不能把未登录 401 当作空列表的证据；空状态依据来自只读数据库统计和隔离浏览器验收。

## 2. 修正后的入口和列表

- 首页「准备这次采购的发票」标题和说明下方、三卡上方，新增独立可点击入口 **「周期性任务 · 网费预演」**，附「查看任务状态、周期和最近结果；真实审批始终关闭」。桌面 1440×900 和手机 390×900 均在首屏可见；实际按钮顶部约为 256 和 317 CSS 像素。页脚链接同步改名，保持直接访问原任务页。
- 保留原 logo、独立「新建报销」、唯一顶栏及其所有操作、祝福/项目/上传三卡。没有新增顶栏、玻璃条、纹样或主题；`web/styles.css`、`tokens.css`、`base.css` 均未修改，主色继续为 `--accent: #1f56c9`。
- 任务页标题改为「周期性任务」，顶部增加「周期性任务列表」。读取到实际保存的配置或已有运行记录时，以 Astryx `List/ListItem` 行展示常规网费的运行状态、扫描周期、最近结果与时间；原详细状态、调度器状态、下一次检查、配置、预演、暂停、失败追踪和完整采购字段预览全部保留。
- 没有配置或记录时，显示 **「尚未配置周期性任务」**，明确当前账号没有保存配置、任务保持关闭，并提供「前往配置网费预演」锚点入口。周期、草稿、扫描起始时间保持空白，不猜测部门、审批人、预算或周期。配置缺失时启用预演按钮禁用。
- 401 显示 **「请先登录飞书查看周期性任务」**、当前未能读取配置/记录的说明、「用飞书登录」和「重新加载任务」按钮。沿用现有登录地址，登录后需重新进入任务页；没有修改 OAuth。
- 403 明示读取权限不足，503/网络等错误明示列表无法加载并可重试；均不会冒充空列表，也不会显示上次已失效的任务配置。

## 3. 文件与既有工作保护

本次文件：

| 文件 | 改动 |
| --- | --- |
| `web/index.html` | 首屏入口、页脚名称、前端缓存戳 |
| `web/automatic-tasks.html` | 页面标题、无障碍名称、JS/CSS 缓存戳 |
| `src/recurring-internet.jsx` | 列表、真实空状态、登录/权限/失败提示、配置锚点和缺配置时禁用预演启用按钮 |
| `web/internet-task/task.js` | 通过既有 `scripts/build-recurring-internet.mjs` 重建的任务页产物 |
| `web/test-recurring-internet.cjs` | 保留预演回归，增加列表、空状态、401/403/503 与重试检查 |
| `web/batch-flow.browser.cjs` | 增加首屏任务入口断言，适配链接缓存戳 |
| `web/periodic-visibility.browser.cjs` | 本机/公网实际静态资源的桌面与手机只读验收、摘要核对和截图 |
| 本文件 | 中文交付结果 |

修改前已读取完整 `git diff` 与全部状态，保存 `/tmp/baoxiao-t104-before.patch`、`/tmp/baoxiao-t104-before-manifest.json`。其中 4 个原有 dirty 文件（`.gitignore`、`README.md`、`web/app.js`、`web/ui.js`）及 25 个原有 untracked 文件，共 29 个文件，修改后 SHA256 全部与初始快照一致。

没有覆盖、删除、暂存或提交这些既有工作；包清单、锁文件、AGENTS/GEMINI、Astryx 工作台源码/产物、主题及压缩资料均保留。只显式暂存本次文件，没有使用 `git add .`。OAuth、核心 OCR、采购提交协议、后端网费执行器和批量业务控制器均未修改，没有回滚 `b6cab40`、`d079880`、`9f7d4c9`。

## 4. 本地提交

实现提交：`cea0f70db170acf0d58337a05082613b7e557159`，`fix(ui): expose recurring tasks and clarify task list states`，包含上表的 7 个代码/测试/静态文件。本结果文件另作本地文档提交。

**确认未执行 git push，没有改远程仓库。**

## 5. 测试与安全边界

- `node web/test-recurring-internet.cjs`：本机 Chrome 临时资料、1200×1000 与 390×1000，所有请求拦截到合成夹具。列表的状态/周期/最近结果、配置保存、启停、运行中暂停、完整预演、恢复关闭、真实空状态、配置跳转、401 登录、403 权限、503 失败和重试恢复全部通过；无横向溢出或 JS 异常，真实审批端点禁止访问。截图中有配置/运行的内容仅为隔离夹具，不是生产任务或运行记录。
- `node web/batch-flow.browser.cjs`：1440×1000、390×1000 通过。原蓝色、logo、单顶栏、无双玻璃条/纹样、三卡桌面等高/手机堆叠、首屏入口、弹窗行为、25 张合成票上传、4 个整单问题、50 个预填选择、手改冲突阻断与修正、完整预览及唯一一次夹具模拟提交均正常；没有真实审批。
- `PYTHONPATH=ocr /Users/chenxibin/anaconda3/bin/python3 -m unittest test_filling_workflow test_recurring_internet`：28 项通过。包括默认关闭、强制 dry-run、发布锁、调度器默认不注册、所有者隔离、网费 HTTP 与原批量预填/人工冲突/预算核对流程。全部使用临时数据库/原件与 mock 网络，不接触生产邮箱或审批。
- 10 组既有前端检查全部通过：UI、采购规则、Hallmark、预算刷新、分类编辑、发票字段、OCR 恢复、Jev、AI 提醒、工作手册。新增/修改 JS 的语法检查与 `git diff --check` 通过。
- Node 22.22.2 下 `npx astryx doctor --built web/internet-task`：25 pass、0 warn、0 fail，日志 `/tmp/baoxiao-t104-doctor.log`。此检查确认产物/依赖健康，不将其冒充源码类型检查或视觉验收；源码沿用既有 Astryx settings 模板和组件，未新添原生布局 div/span、自写 CSS 或主题。
- `node web/periodic-visibility.browser.cjs`：本机和公网各 1440×900、390×900，通过首屏入口、点击进入任务页、明确登录提示、蓝色主流程结构、无横向溢出和无 JS 异常检查。页面 API 全部拦截为未登录夹具，仅额外通过全新无 Cookie 请求实际 GET 两处任务状态 API，均为 401；没有触发登录流程。
- 默认沙箱不允许启动 Chrome/绑定测试 HTTP 端口，相关验收在获准的本机执行环境中使用相同隔离夹具完成；未因此触碰真实业务接口。

**零真实审批、零生产邮箱扫描、零任务配置写入、零任务启用。** `FORCE_DRY_RUN=True`、`LIVE_RELEASE_ENABLED=False`、数据库 `enabled DEFAULT 0` 原样保留，环境/API/页面均不能解开真实提交锁。本次未设置调度器变量，未注册任何调度器。当前执行环境与 `.env` 均未启用 `BAOXIAO_INTERNET_DRY_RUN_SCHEDULER`；没有读取或推断运行中服务的私有进程环境。

生产库测试前后的只读聚合统计完全一致：默认状态行 1、已配置 0、启用 0、运行中 0、运行记录 0。证据为 `/tmp/baoxiao-t104-safety-before.json` 和 `/tmp/baoxiao-t104-safety-after.json`。没有为了截图向生产添加示例数据。

## 6. 缓存、本机/线上核对与重启

新缓存戳：**`20261124periodic1`**。用于首页样式及四个既有脚本、任务页入口链接、任务页 `task.js` 和 `task.css`。未改动的 tokens/base/font/logo 保留既有版本。

- 本机 `http://127.0.0.1:5173/?v=20261124periodic1` 和公网 `https://baoxiao.xbchen.top/?v=20261124periodic1` 都已读到新首页入口，任务页已读取新缓存戳的 bundle。
- 每种站点/尺寸实际核对 16 个页面/静态响应；脚本、CSS、logo 和任务字体等静态内容的 SHA256 均与本仓库一致。两页 HTML 检查新版本标记和浏览器呈现，公网存在 Cloudflare 注入，不宣称 HTML 字节完全一致；第三方统计脚本拦截为空脚本。
- 明细：`/tmp/baoxiao-t104-live-verification.json`；修改前首页证据：`/tmp/t104-local-before.html`、`/tmp/t104-public-before.html`；修改前本机 API：`/tmp/t104-task-headers`、`/tmp/t104-task-before.json`。
- **本次没有重启，也无需重启。** 仅前端静态修改，现有服务已经实际提供新资源；后端任务 API 当前能返回正确的未登录 401。本次未执行 `./restart-local.sh` 或 `/bin/ps`，没有重试历史文档中因沙箱被禁止的重启操作。

## 7. 截图路径

已打开并人工复核本机桌面/手机首页、公网手机首页与桌面登录提示、手机配置列表、桌面/手机真实空状态及手机登录提示。表内配置/空状态夹具图不代表已对生产执行配置或预演。

| 范围 | 桌面 | 手机 |
| --- | --- | --- |
| 本机实际静态首页 | `/tmp/baoxiao-t104-local-home-1440.png` | `/tmp/baoxiao-t104-local-home-390.png` |
| 公网实际静态首页 | `/tmp/baoxiao-t104-public-home-1440.png` | `/tmp/baoxiao-t104-public-home-390.png` |
| 本机实际任务页，登录提示夹具 | `/tmp/baoxiao-t104-local-login-1440.png` | `/tmp/baoxiao-t104-local-login-390.png` |
| 公网实际任务页，登录提示夹具 | `/tmp/baoxiao-t104-public-login-1440.png` | `/tmp/baoxiao-t104-public-login-390.png` |
| 任务页：无配置/无记录夹具 | `/tmp/baoxiao-t104-task-empty-1200.png` | `/tmp/baoxiao-t104-task-empty-390.png` |
| 任务页：配置/运行结果夹具 | `/tmp/baoxiao-t104-task-configured-1200.png` | `/tmp/baoxiao-t104-task-configured-390.png` |
| 任务页：未登录夹具 | `/tmp/baoxiao-t104-task-login-1200.png` | `/tmp/baoxiao-t104-task-login-390.png` |
| 批量可编辑预填清单 | `/tmp/baoxiao-batch-1440-list.png` | `/tmp/baoxiao-batch-390-list.png` |
| 批量完整提交前预览 | `/tmp/baoxiao-batch-1440-preview.png` | `/tmp/baoxiao-batch-390-preview.png` |

## 8. 阻塞项与交接边界

本次入口与可见性修正没有未解决的阻塞。生产目前没有周期配置/记录，用户必须先用自己的飞书账号登录才能读取自己的任务数据；需要实际配置时，应由用户明确选择周期、草稿、扫描边界及税号/网费账户规则。本次没有代填、启用或扫描。

生产登录后的浏览器数据读取及真实邮箱联调没有执行；配置、列表和预演回归采用隔离夹具及临时数据库验证。真实自动提交仍被代码常量封锁，本次交付不能解释为周期自动审批已经启用。
