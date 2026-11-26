# Astryx 界面接入

当前状态（2026-11-26）：线上入口使用原生蓝色工作台，未加载 Astryx 的 workspace.js / workspace.css。以下记录保留的 Astryx 安装、模板与构建方案；构建这些文件不会自动切换线上入口。当前验收脚本验证六环节原生界面及提交确认恢复。

2026-11-24，按 [官方仓库](https://github.com/meta/astryx) 和 [Core 安装文档](https://github.com/meta/astryx/blob/main/packages/core/README.md) 接入。Core、CLI、Neutral 主题固定为 0.7.17，React / React DOM 为 19.3.1。CLI 要求 Node >=22.13；本项目 `.nvmrc` 为 22.22.2。

## 已执行的官方流程

```bash
npm install --save-exact react@19 react-dom@19 @astryxdesign/core @astryxdesign/theme-neutral @stylexjs/stylex
npm install -D --save-exact @astryxdesign/cli esbuild
npx @astryxdesign/cli init
npx @astryxdesign/cli theme add neutral
npx @astryxdesign/cli build "expense reimbursement workspace with four-step form wizard, invoice upload, budget selection, invoice list and review before submit"
npx @astryxdesign/cli template form-wizard --type page src/astryx/form-wizard.tsx
```

已读取生成的 `AGENTS.md`、Layout 指南和各组件 API。生成的 `astryx-themes.js` 引入官方已构建主题及本地字体。保留的 Astryx 界面使用 AppShell、SideNav、TopNav、Layout、LayoutHeader、LayoutContent、Stepper、Step、Button、Avatar、Icon、Heading、Text、Stack 和 InternationalizationProvider。

`src/astryx/form-wizard.tsx` 从官方 form-wizard 模板改编，保留 Layout 的 header/content 分区、padding=5、VStack gap=5、顶部 on-track Stepper 和每次一个业务步骤的结构。模板的演示字段替换为现有发票流程。

## 构建与运行

```bash
nvm use
npm ci
npm run build
npm run astryx -- doctor --built src/astryx
```

`web/astryx/` 是提交到仓库的可部署静态产物，含 React、Astryx、主题 CSS 及字体。原 Python 静态服务直接提供这些文件，无需增加 Node 服务或依赖 CDN。日常运行仍用 `restart-local.sh`，本机由 `com.xbchen.baoxiao` LaunchAgent 托管。

## 与现有业务逻辑的边界

- `main.jsx` 在 app.js 初始化前同步挂载界面，将原节点迁入组件槽位，保留控件 ID、原件引用、已编辑内容和事件绑定。
- 静态操作按钮换成 Astryx Button。旧控制器通过原生 `disabled` 和文本更新控制状态，桥接不将其固化为 React `isDisabled`。
- `setStage` 发送 `expense:stage` 事件，Stepper 只展示进度，不绕过业务校验跳步。
- 表格和动态票据字段继续由原控制器拥有，避免 React 重绘覆盖手动修改。`legacy.css` 将原样式放到低优先级 layer；`workspace.css` 仅以官方语义 token 适配旧业务区域。
- 旧工具栏保留为隐藏的唯一命令目标。手机和电脑导航调用同一目标，避免重复 ID。登录区域移至 TopNav。
- 弹窗打开时将整个 Astryx 根节点设为 inert，沿用既有焦点约束和 Escape 关闭行为。
- OAuth、OCR、附件、审批接口、防重复提交和学习规则未修改。

## 最初接入时的验证

`web/batch-flow.browser.cjs` 在 1440 / 390 宽度，用本地资源和合成 API 验证 25 张票、4 个整单回答、50 个预填项、完整预览、手改冲突拦截及修正后一次模拟提交；同时检查唯一主区域、无重复 ID、Stepper 同步和无横向溢出；另外验证记录弹窗、手机导航到 AI 设置、Escape 关闭及整个工作台的 inert 恢复。所有审批请求均被夹具拦截。

另运行 `node web/test-ui.cjs`、`node web/test-purchase-policy.cjs`、JavaScript 语法检查和官方 `doctor --built`。后者允许旧区域适配层的 className 样式警告，无失败项。
