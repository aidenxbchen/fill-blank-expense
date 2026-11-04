# 填空报销

把报销从「写一篇流水账」变成「按场景填空」：先选场景 → 按结构丢发票 → 一眼看出缺什么 → OCR（本地 Xiaomi-OCR / mock）+ 飞书审批（stub）。

## 覆盖场景（四选一）

顶部 Tab 切换；**每个场景草稿独立存** `localStorage`（键前缀 `fill-blank-expense:v2:<scenario>`）。旧版差旅草稿（`fill-blank-expense:v1`）会自动迁到 `travel`。

| 场景 | id | 填空结构 | 缺口规则 |
|------|-----|----------|----------|
| 差旅 | `travel` | 起止日期 / 城市 / 事由 → 按天槽位：住宿 / 餐饮 / 交通·其他 | 某天缺住宿或餐饮 |
| 日常采购 | `purchase` | 品名 / 供应商 / 日期 / 金额；可按行或整单挂发票 | 缺金额，或行与整单都无发票 |
| 市内交通 | `local_transit` | 每次出行：日期、起点、终点、方式、金额 + 票据 | 缺票据/发票 |
| 招待宴请 | `entertainment` | 每场：日期、对象/事由、人数、金额；槽位 餐费 / 礼品·其他 | 缺餐费发票 |

共用能力：发票上传、`parseInvoice` / `window.__invoiceOCR`、金额汇总、缺口提示、「一键生成报销草稿」（JSON + 摘要，含 `scenario` 字段）、飞书 stub 注释。

## 本地打开（仅前端 / mock OCR）

```bash
cd web
python3 -m http.server 5173
```

浏览器访问：http://127.0.0.1:5173

也可直接用浏览器打开 `web/index.html`（部分浏览器对本地文件拖拽/下载行为略有差异，推荐用上面的本地服务）。

不启动 OCR 桥接时，`ocr-bridge.js` 会在健康检查失败后抛错；若你暂时不想用真实 OCR，可暂时从 `index.html` 去掉 `ocr-bridge.js`，`app.js` 会回退到内置 mock。

## 真实 OCR（Xiaomi-OCR via Ollama）

实验性路径：通过 **Ollama 的 OpenAI 兼容接口** 调用视觉 OCR 模型（GGUF）。官方模型仓库：[SeerRay-Lab/Xiaomi-OCR-0](https://github.com/SeerRay-Lab/Xiaomi-OCR-0)。Ollama 模型名以社区/自建 tag 为准，默认：

`longwayxu/xiaomi-ocr-0:bf16`

### 1. 安装并启动 Ollama

```bash
# 安装 Ollama：https://ollama.com
ollama pull longwayxu/xiaomi-ocr-0:bf16
ollama serve
```

默认监听 `http://127.0.0.1:11434`。可用环境变量覆盖：

- `XIAOMI_OCR_LOCAL_URL` — 默认 `http://127.0.0.1:11434/v1`
- `XIAOMI_OCR_MODEL` — 默认 `longwayxu/xiaomi-ocr-0:bf16`

### 2. 启动本地 OCR 桥接

```bash
# 仓库根目录
python3 ocr/server.py
# → http://127.0.0.1:8790
# GET  /api/health
# POST /api/parse-invoice  (multipart field: file= 图片)
```

`ocr/server.py` **仅用 Python 3 标准库**（无需 `pip install`）。当前以 **图片**（JPEG/PNG/WebP 等）为主；PDF 会返回明确错误，建议先转成首页图片再上传。OCR 失败返回 HTTP 502，**不会静默编造金额**。

### 3. 打开前端

```bash
cd web
python3 -m http.server 5173
```

`web/ocr-bridge.js` 在 `app.js` 之前加载，设置：

```js
window.__invoiceOCR = async (file, opts) => { /* → 8790 /api/parse-invoice */ }
```

返回形状：`{ amount, merchant, date, category, confidence, source: 'xiaomi-ocr-0', raw? }`。健康检查或识别失败时 **throw**，由上层提示；不要依赖桥接静默 mock 金额。

## 已实现

- **场景切换**：顶部差旅 / 日常采购 / 市内交通 / 招待宴请；分场景 localStorage
- **差旅**：起止日期、城市、事由；按天「住宿 / 餐饮 / 交通·其他」；改日期保留重叠日发票
- **日常采购**：采购行（品名/供应商/日期/金额）+ 行发票或整单发票
- **市内交通**：出行条目（日期/起终点/方式/金额）+ 票据
- **招待宴请**：场次（日期/对象事由/人数/金额）+ 餐费 / 礼品·其他槽位
- 发票上传：文件选择或拖拽 PDF/图片；`parseInvoice(file)` 经 `__invoiceOCR` 或 mock；可删除
- OCR 替换钩子：`window.__invoiceOCR`；本仓库提供 `web/ocr-bridge.js` + `ocr/server.py`（Xiaomi-OCR / Ollama）
- 缺口提示 + 金额汇总（随场景变化）
- 「一键生成报销草稿」：JSON（含 `scenario` / `scenarioLabel`）+ 可读摘要；桌面右侧 sticky CTA，窄屏底部 bar
- 飞书审批：代码内注释 stub（`lark-cli` brand=feishu），**不调用真实 API**

## UI 说明

- 顶部先选场景，再走流程：设置 → 填空 → 缺口/汇总 → 生成草稿
- 缺项：暖色虚线 +「尚未填入」；已填：实线、平静底色
- 无框架；字体为 system-ui + 中文系统字体栈；主色为单一青绿 accent，无紫色 AI 风格

## 尚未实现

- PDF 首页自动栅格化（桥接目前要求图片）
- 飞书审批实例创建与提交
- invoice-assistant 导入对接

## 技术说明

纯 HTML / CSS / JS，无框架。入口：`web/index.html`，样式 `web/styles.css`，逻辑 `web/app.js`，OCR 钩子 `web/ocr-bridge.js`。本地桥接：`ocr/server.py`（stdlib）。
