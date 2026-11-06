# 填空报销

把报销从「对着表格填空」变成「**把发票全丢进来 → AI 按团队规范一句句问 → 生成草稿 → 提交飞书**」。

公网演示：https://baoxiao.xbchen.top （硬刷新；资源带 `?v=` 防缓存）

## 产品故事（默认体验）

1. **丢发票**：一个大拖放区，一次多张 PDF / 图片，不必先选场景或按天找槽位。
2. **识别**：走现有 `/api/parse-invoice`（PDF 文本 / 栅格化 + Xiaomi-OCR on Mini）。
3. **问答**：按内置 `POLICY`（典型中国初创规范）**一次只问一个问题**（事由、项目/成本中心、谁吃了、有无酒水、对公/私人、缺日期、类别冲突、无票现金等）。Chips + 自由输入；进度「还差 N 个问题」。
4. **草稿**：按类别生成可编辑明细表 + 摘要字段；可改、可加无票行。
5. **提交飞书**：按钮调用 `POST /api/feishu-expense`（**明确 stub**，弹窗展示 payload；真实飞书审批后续再接）。

会话落在 `localStorage` 键 `fill-blank-expense:delight:v1`。

旧版「按场景填空」仍在 [`web/classic/`](web/classic/)（页头「经典填空」入口），默认落地页是新流程。

## 怎么在 baoxiao 上试（5 步）

1. 打开 https://baoxiao.xbchen.top 并 **硬刷新**（应看到「把发票全丢进来」英雄区，而不是差旅 Tab）。
2. 一次拖入 **多张** 发票（可用仓库里的 `test-invoice.pdf` + 任意图片）；等待识别芯片变成金额/类别。
3. 点 **开始问答**，用下方 chips 或输入框 **逐题回答**；注意顶部「还差 N 个问题」。
4. 问完后自动进入 **报销草稿**：检查分类表，随便改一行金额，看合计更新。
5. **确认，去提交飞书** → **提交飞书报销** → 应弹出 stub 成功 payload（含 `feishuApprovalId` / `echo`）。

## 本地启动

```bash
./restart-local.sh
# 或分别：
# python3 ocr/server.py          → :18790
# python3 web/serve.py --port 5173
```

- 前端：http://127.0.0.1:5173
- OCR / API：`GET /api/health` · `POST /api/parse-invoice` · `POST /api/feishu-expense`（stub）
- 飞书登录：`GET /api/auth/feishu/login` → 回调 `/api/auth/feishu/callback` · `GET /api/auth/me` · `POST /api/auth/logout` · `GET /api/budgets`（当前用户已通过的立项/变更/出差）
- 在页面点「用飞书登录」，授权后可点选已通过预算，问答会自动带上项目
- 凭证放仓库根目录 `.env`（见 `.env.example`，不要提交）。需配置重定向 URL `https://baoxiao.xbchen.top/api/auth/feishu/callback`
- 隧道：`baoxiao.xbchen.top` 的 `/api` → OCR `:18790`，其余 → web `:5173`

## 报销政策（mock）

- JS：`web/policy.js` → `window.ExpensePolicy.POLICY` + `buildQuestionQueue` / `nextQuestion`
- JSON 镜像：`web/policy.json`
- v1 **纯规则引擎**（无外部 LLM）；预留 `window.__expenseInterviewLLM` 挂钩，便于后续接入模型。

规则示例：强制事由；采购要项目名；招待要对方公司；餐饮问同席/酒水/对公私人；可选差旅餐住上限软提醒；缺日期与商户-类别冲突会追问。

## OCR

`web/ocr-bridge.js` 设置 `window.__invoiceOCR`。本机直连 `http://127.0.0.1:18790`；公网走同源 `/api`。PDF 优先文本抽取，失败再首页栅格化 + 视觉 OCR。桥接失败时前端 mock 仅用于无 OCR 本地点点看。

## 技术

纯 HTML / CSS / JS。入口 `web/index.html`；样式 `web/styles.css`；逻辑 `web/app.js`；政策 `web/policy.js`；OCR `web/ocr-bridge.js` + `ocr/server.py`。

## 尚未实现

- 真实飞书审批实例创建
- LLM 问答（结构已预留）
- 与 invoice-assistant 深度对接
