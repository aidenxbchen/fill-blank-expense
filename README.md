# 填空报销

把差旅报销从「写一篇流水账」变成「按天填空」：选起止日期 → 按天丢入住宿/餐饮/交通发票 → 一眼看出哪天缺什么 →（后续）AI OCR + 飞书审批。

## 本地打开

```bash
cd web
python3 -m http.server 5173
```

浏览器访问：http://127.0.0.1:5173

也可直接用浏览器打开 `web/index.html`（部分浏览器对本地文件拖拽/下载行为略有差异，推荐用上面的本地服务）。

## 已实现

- 行程设置：起止日期、城市、事由；改日期自动重生按天时间轴
- 按天填空：每天至少「住宿 / 餐饮 / 交通·其他」三个槽位
- 发票上传：文件选择或拖拽 PDF/图片；`parseInvoice(file)` mock 解析并挂到槽位；可删除
- OCR 替换钩子：设置 `window.__invoiceOCR = async (file, opts) => ({...})` 即可接入 Xiaomi-OCR 等，返回形状与 mock 一致
- 缺口提示：缺住宿/餐饮的日期高亮 + 汇总
- 金额汇总：按天、按类别小计 + 行程合计（CNY）
- 「一键生成报销草稿」：下载结构化 JSON + 可读摘要（可复制）；桌面右侧 sticky CTA，窄屏底部 sticky bar
- `localStorage` 持久化
- 飞书审批：代码内注释 stub（`lark-cli` brand=feishu），**不调用真实 API**

## UI 说明

- 流程自上而下：行程 → 按天填空 → 缺口/汇总 → 生成草稿
- 缺槽位（住宿/餐饮空）：暖色虚线 +「尚未填入」；已填槽位：实线、平静底色
- 无框架；字体为 system-ui + 中文系统字体栈；主色为单一青绿 accent，无紫色 AI 风格

## 尚未实现

- 真实 AI OCR / 发票识别（当前为 mock；可用 `__invoiceOCR` 挂接）
- 飞书审批实例创建与提交
- invoice-assistant 导入对接

## 技术说明

纯 HTML / CSS / JS，无框架。入口：`web/index.html`，样式 `web/styles.css`，逻辑 `web/app.js`。
