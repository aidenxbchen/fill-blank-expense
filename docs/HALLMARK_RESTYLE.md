# Hallmark app restyle 文件级计划

2026-11-11，基线09554c45c1fcdb167e76a371a591ded0be7d18a9。采用官方 Hallmark v2 audit → redesign keep the layout / restyle --scope app；不作营销custom新建。

## 已核实的前置功能

昨晚数量/单位自动抽取、合开1份/批、跨用户发票占用与SHA识别缓存、成对银行档案均已在09554c4落地。基线122项Python测试和6组前端测试通过。无未提交源码；.qa-mirror/和taste-brief资料为原有未跟踪文件，原样保留，不stash。

## Audit / Picks

- 用途：员工上传原件、核对识别汇总、按项目补齐采购，保留草稿续填。
- 保留：宽屏祝福/预算/上传三卡等高，竖屏堆叠，下方明细；本山照片、报了呗、精确轻松标语、独立新建、单顶栏、原有浅暖/冷蓝卡片配色。
- 可见模板痕迹：背景网格、环形、颗粒、层叠光晕；祝福渐变字和角饰、英文大写眉标；同类按钮/卡片统一浮起；边框+重阴影+磨砂多重叠加。
- 静态基线：114 FAIL / 57 REFLEX / 10 WARN。主要是108处token外色值、spacing、渐变字、焦点环过渡。三个67为中文内容含AI/API/OCR的缩写误判，用语义abbr标注保留原文，禁止删掉API说明求过关。
- 深度：restyle；scope app；genre modern-minimal；theme brand（取自现有源码，不deal营销主题）。签名仍是可编辑发票账单和用户自己的本山logo，不加新图/数据。

## 文件级执行

| 文件 | 操作 |
| --- | --- |
| web/styles.css | 改：收敛装饰和材质，统一字级/控件/边界，保留全部布局与状态选择器；视觉装饰不动业务ID |
| web/tokens.css | 新增：官方brand/app scaffold基础，填现有品牌/卡片色及字体、app scale、spacing |
| web/base.css | 新增：官方scaffold基础规则，按现有app适配；不替换事件或组件树 |
| web/index.html | 改：缓存戳20261111hallmark1；语义缩写、移位祝福caption、去箭头文字符号及装饰；所有ID/字段/脚本/路由保留 |
| web/app.js | 仅缓存戳及必要的纯展示分隔符；不改变请求、提交、草稿、AI隔离逻辑 |
| docs/HALLMARK_RESTYLE.md / .hallmark | 新增：官方版本、计划、before/kept报告、规则例外/验证证据 |
| 测试 | 保留现有测试不为过lint改断言；可新增视觉/接线回归检查 |
| 删除 | 无文件、路由或组件树删除；不改后端、数据、权限、采购映射 |

## 验证计划与当前限制

官方sloplint静态scope app/before/kept，保留接线记录；真实运行路由用既有5173。当前已连接Browser截图超时无图片；官方render脚本要求另起Chrome，当前浏览器规则禁止替换已选择Browser。将如实区分官方静态、真实Browser检查与未执行的官方render，不写虚构render/screenshot通过。合成账号数据用于问答、银行、弹窗和失败态，不接触真实密钥/发票，不发真实审批。多宽度320/375/390/414/768/1024/1280/1440/1920；最后自身测试、本地commit、restart-local.sh，公网health/新资源200；不push。


## 实际结果与接线

- 官方源码版本：7e213cb6feb4ef82733bd66a0600b2e54ca0994c。按README、SKILL、redesign、flow及相关gates/craft/patterns/interaction-and-states，实际运行brand/app scaffold；未安装全局Skill或依赖，未执行无关外部操作。工具来源和摘要见.hallmark/toolchain.json。
- 样式主体采用品牌tokens和官方base；删去CSS光晕、网格、环形、粒子和祝福渐变字/角饰的绘制，保留其无业务DOM。照片/原有浅暖冷蓝卡色/三卡布局保留，移除同类控件统一浮起。玻璃仅保留顶栏、菜单、弹窗和提示等chrome。主内容清晰，表格手机仍逐票标签化；旧hidden强制规则和所有状态保留。
- app.js的唯一差异是资源版本；ui.js/ocr-bridge.js/policy.js及全部后端完全未修改，缓存忽略后SHA与基线一致。全部旧HTML IDs保留；官方kept结果4/4 links、4/4 fields、102/102 script hooks。新增test-hallmark.cjs的--kept-source显式验证快照，不把永久禁止业务演进当成常规单测。
- 文案变动：祝福眉标“今日小诗 · tap to shuffle”改为页脚caption“今日小诗”，操作仍“换一句”；移除按钮上附加箭头/星号；“还差 — 个问题”改为“正在准备问题”。AI/API/OCR为语义abbr，文字本身不改，避免中文缩写被误判为tracked-caps标签。品牌及精确标语不改，法律/权限/密钥隔离说明不改。
- 一次源代码复核修正了官方base段落reset造成的首次提醒段落拥挤；实测段距16px。另修预算空态按钮/预算列表纵向被拉高、表格small默认10px，以及320px操作栏三行占高，保持新建独立可达。

## 真实执行的验证

官方命令（HALLMARK_DIR指上述已核验官方副本，仓库根目录运行）：

```sh
node "$HALLMARK_DIR/scripts/sloplint.mjs" web/index.html web/styles.css --scope app --genre modern-minimal --before
node "$HALLMARK_DIR/scripts/sloplint.mjs" web/index.html web/styles.css --scope app --genre modern-minimal --render --url http://127.0.0.1:5173/ --kept
node web/test-hallmark.cjs --kept-source
```

1. 静态：基线114 FAIL/57 REFLEX/10 WARN；修改后0 FAIL/0 REFLEX/0 WARN，3条已记录dismiss（用户要求三卡而非营销icon tiles，单一玻璃顶栏/菜单）。39b例外记录：dropzone及富项目行是大面积文件/项目目标，不是普通工具栏按钮。
2. 官方CLI render **not run**，实际输出“no puppeteer-core found locally, globally or via HALLMARK_PUPPETEER”。脚本会另起Chrome，与本次必须使用已连接Browser的规则冲突，未为绕过限制安装并启动另一浏览器。不声称此项通过。
3. 在选定Browser中真实加载 localhost:5173/；官方observe()/observeQuality()函数原样在该页面的iframe中执行。320/375/390/414/768/1024/1280/1440/1920无页面横向溢出、observe无finding；宽屏三卡全部320px等高，竖屏堆叠。quality仅39b dropzone320px的已记录例外。这不是完整Puppeteer renderCheck，未做截图像素探针或完整交互检测。证据.hallmark/browser-after.json。
4. 合成fixture使用真实HTML/CSS/JS并拦截全部API：首次AI提醒、项目+金额问答、银行档案新增与成对选择、自动保存失败→保留→重试成功；模拟缺scope提交失败、双击仅1次模拟请求、原件和草稿保留。没有调用真实采购审批/消息，没有查看真实密钥或发票。
5. 自身检查：122项Python unittest、7组前端测试、JS语法与git diff --check通过；原有测试断言未改。新增fixture展开本地tokens/base，无外部样式依赖。

## 尚未完成的视觉验收

截图两次均返回“Screenshot timed out”，包括390×640的小区域；没有保存截图文件，没有截图路径。官方compare.html未生成。fresh-context finish review结论为recapture（缺图），仅独立源代码发现的一条弹窗段距问题已修复；没有捏造ship或完成视觉比较。实际iOS软键盘/字体与视觉仍待截图能力恢复后复核。

## 上线

缓存20261111hallmark1；入口 https://baoxiao.xbchen.top/?v=20261111hallmark1 。本地提交后执行既有restart-local.sh --managed，验证公网health与HTML/styles/tokens/base/app/policy/OCR桥接/logo状态和摘要。不push。昨晚三项功能代码保留，现有未知提交占用和原件/用户隔离规则未改；这些业务仍只用合成测试验证，本次未真实发单验收。
