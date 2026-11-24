# t102u：恢复「报了呗」历史蓝色界面

执行日期：2026-11-24。仅在 `/Users/chenxibin/Code/fill-blank-expense` 工作，没有新建项目、克隆、拉取或修改远程仓库。

1. **历史／设计依据**

   - `6a1cbf021b09b6566e71fa1fcf3e39acfd13851d`：单顶栏、裸流程进度与保存状态。依据为 `docs/CHROME_MS1.md` 及对应首页历史。
   - `d8279f68cb7455f70314a9b6ba5b0742b92937ad`：祝福／关联项目／上传三卡等高布局，竖屏堆叠，移除眼睛纹样。
   - `cf2660c18de407b0a72a19ef64507f01974e07aa`：现有蓝色品牌、浅暖／冷蓝卡片结构。依据为 `web/tokens.css`、`web/styles.css`、`web/base.css` 和 `docs/HALLMARK_RESTYLE.md`。主色沿用 `--accent: #1f56c9`，没有另造主题。
   - 上述样式仍完整存在于 `d079880`。本次直接恢复其资源入口，CSS 文件逐字节保持不变，保留 `b6cab40` 新增的批量清单／预览样式；没有回滚两个功能提交。

2. **文件改动与已有工作保护**

   - `web/index.html`：移除黑白 Astryx 首页资源入口和 neutral 主题属性，重新加载既有 `styles.css`；四个业务脚本保留，更新缓存戳。原 logo、独立「新建报销」、单顶栏、三卡、工作手册与网费任务入口均保留。未添加页面结构、装饰或新主题。
   - `web/batch-flow.browser.cjs`：合并原有未提交的错误日志、Jev 离线夹具、唯一 ID、弹窗 inert／Escape、阶段同步检查，将 Astryx 专属断言适配到恢复后的原工作台；增加历史蓝色、原 logo、单顶栏、三卡等高／手机堆叠、无双玻璃条、隐藏装饰、无溢出与首页截图检查。原有 25 张票主流程检查完整保留。
   - 本文件记录验收结果。
   - 开始前已阅读全部 dirty diff，并保存 `/tmp/baoxiao-t102u-before.patch` 与 `/tmp/baoxiao-t102u-before-manifest.json`。结束时核对 SHA256：原有 `.gitignore`、`README.md`、`web/app.js`、`web/ui.js` 的未提交内容逐字节保持原样；原有全部 25 个未跟踪文件亦逐字节保留，没有删除、覆盖或混入提交。包括包清单、构建脚本、Astryx 源码／资源、AGENTS/GEMINI、主题文件和设计压缩包。
   - OAuth、核心 OCR、采购提交协议、网费代码／独立页面资源均未修改。

3. **本地提交**

   实现提交：`9f7d4c9fd3f8973138948ec9522a9537bd0fa7f8`，`fix(ui): restore historical blue expense workspace`，只包含首页入口与相关浏览器测试。本报告另作本地文档提交。没有执行 `git push`，没有修改远程仓库。

4. **测试与安全结果**

   - 本机 Chrome 临时资料、全量网络拦截的批量浏览器验收：1440×1000、390×1000 均通过。25 张合成票上传／识别、只回答 4 个整单问题、50 个可编辑预填字段、完整逐票预览、手改冲突保留并阻止提交、修正后仅 1 次夹具模拟提交、无 JS 异常／横向溢出；记录弹窗、手机 AI 设置弹窗、Escape、焦点背景 inert 恢复均通过。
   - 网费独立页离线验收：1200×1000、390×1000 均通过。默认暂停／预演按钮禁用、保存配置、启停、运行中暂停、完整预演、最终恢复暂停、无溢出／JS 异常，真实审批端点禁止访问。没有访问生产邮箱。
   - `PYTHONPATH=ocr /Users/chenxibin/anaconda3/bin/python3 -m unittest test_filling_workflow test_recurring_internet`：28 项通过，覆盖预填、人工冲突、预览、提交后学习与预算核实、所有者隔离、强制 dry-run、发布锁、默认关闭、不注册调度器及网费 HTTP 流程。数据库／原件目录均为临时测试数据，真实网络／创建审批／附件上传默认禁止。
   - 10 组既有前端检查通过：UI、采购规则、Hallmark 接线、预算刷新、分类修改、发票字段、OCR 恢复、Jev、AI 提醒、工作手册。JavaScript 语法与 `git diff --check` 通过。
   - Node 22.22.2 下运行 `npx astryx doctor --built web`：25 pass、0 warn、0 fail。日志 `/tmp/baoxiao-t102u-doctor.log`。它确认现有网费／Astryx 产物依赖健康；旧首页没有 JSX，组件纯度未检查，不将此结果冒充首页视觉验收。
   - 本地与公网实际静态资源的桌面／手机 Chrome 只读验收通过；所有 API 都由未登录夹具拦截，真实 API 调用 0。CSS、tokens、base、四个脚本及 logo 的响应 SHA256 均与仓库一致。公网 HTML 存在 Cloudflare 统计脚本注入，浏览器中已将该第三方请求拦截为空脚本；未将公网 HTML 宣称为逐字节一致。核验明细 `/tmp/baoxiao-t102u-live-verification.json`。
   - **真实审批为 0；没有真实提交、真实邮箱扫描或生产任务配置写入。** `FORCE_DRY_RUN=True`、`LIVE_RELEASE_ENABLED=False` 和任务 `enabled DEFAULT 0` 的代码保持不变。启动环境／`.env` 未开启网费预演调度器；重启尝试前后以只读 SQLite 查询确认生产库尚无 `internet_tasks` 表，没有已启用任务。本次没有设置调度器变量或创建周期任务。

5. **重启、缓存与站点核对**

   - 新 cache-bust：`20261124blue1`，用于首页主 CSS 和四个业务脚本。tokens／base 内容未改，保留其既有缓存戳。
   - 已仅尝试一次 `./restart-local.sh`：输出 `ollama already on 11434` 后，在第 23 行读取监听进程命令时出现 `/bin/ps: Operation not permitted`，退出码 126。脚本尚未执行 OCR/Web 的 kill 或 replacement 启动，**本次未完成服务重启**，没有升级权限反复硬试。
   - 现有静态服务会直接读取本仓库文件。因此即使没有重启，本地 `http://127.0.0.1:5173/` 与 `https://baoxiao.xbchen.top/` 均已实际读到蓝色入口，桌面／手机截图、蓝色按钮计算样式与业务静态资源摘要核对通过。curl 首页也均指向新缓存戳。
   - 此结论仅证明当前前端资源已恢复蓝色，不代表后端完成重载或网费自动化上线；没有声称「已完成上线」。

6. **截图路径**

   已打开并人工复核桌面／手机首页、公网首页及手机网费预演截图。其余流程截图由通过的浏览器测试生成。

   | 范围 | 桌面 | 手机 |
   | --- | --- | --- |
   | 实际本地首页（API 离线拦截） | `/tmp/baoxiao-blue-local-1440.png` | `/tmp/baoxiao-blue-local-390.png` |
   | 实际公网首页（API 离线拦截） | `/tmp/baoxiao-blue-public-1440.png` | `/tmp/baoxiao-blue-public-390.png` |
   | 合成账号首页 | `/tmp/baoxiao-blue-1440-home.png` | `/tmp/baoxiao-blue-390-home.png` |
   | 25 张票可编辑清单 | `/tmp/baoxiao-batch-1440-list.png` | `/tmp/baoxiao-batch-390-list.png` |
   | 提交前完整预览 | `/tmp/baoxiao-batch-1440-preview.png` | `/tmp/baoxiao-batch-390-preview.png` |
   | 网费安全预演独立页 | `/tmp/baoxiao-internet-task-1200.png` | `/tmp/baoxiao-internet-task-390.png` |

7. **阻塞与交接**

   唯一未完成的操作是 OCR/Web 服务重启：受沙箱 `/bin/ps` 权限限制，交由协调者在有权限的本机终端补执行一次 `./restart-local.sh`，并在重启后确认网费仍默认暂停、dry-run 为 true、真实执行锁关闭、调度器未开启。不要启用任务或扫描生产邮箱。前端蓝色恢复、本地提交、桌面／手机与隔离业务验收已完成；生产登录后的端到端审批／邮箱操作按要求未执行。
