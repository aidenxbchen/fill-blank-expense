# 报了么 Liquid Glass redesign — REPORT

Date: 2026-11-09 (Asia/Shanghai)

## Files changed
- `index.html` — brand rename, logo mark, tagline, header action layout, cache-bust `?v=20261109glass1`, ambient layer
- `styles.css` — full token + material rewrite (liquid glass chrome); functional selectors preserved
- `ui.js` — **unchanged** (IDs / dialog hooks still match)
- `app.js` — **unchanged**

Not deployed. Parent copies back to Mac mini and restarts.

## Key visual decisions
- Brand **报了么**; page title `报了么 | ANEVER 采购工作台`
- Logo: frosted glass rounded square with「报」(no clipped 填 tile)
- Tagline exact: 发票往里一扔，项目往下一选；该填的它问你，该交的它替你交。一报了之，完事儿。
- Cool luminous gray-blue mesh ambient (CSS only; no purple AI gradient)
- Frosted materials on header, stage rail, panels, dropzone, menus, modals, toast: `backdrop-filter` + saturate, 1px specular top edge, soft rim, layered soft shadows
- Primary CTAs stay solid accent blue for WCAG AA contrast
- Motion tokens: `--m-in 150ms`, `--m-out 120ms`, `--m-press 90ms`, ease `cubic-bezier(.2,.8,.2,1)`; hover lift / press scale `.985` under `(hover:hover) and (pointer:fine)` only; `prefers-reduced-motion` kills motion
- Editorial calm inspired by pulkit.page/claude-directory: generous whitespace, sharp type hierarchy, restrained cool palette

## ID / HTML structure notes
- **All prior element IDs kept** (auth, stages, dropzone, tables, chat, draft, submit, modals, toast, save strip, AI form fields, etc.)
- `#btn-reset` (**新建报销**) moved out of `.workspace-menu-items` into `.header-actions` as always-visible `.btn-secondary.btn-new`
- 更多 menu now only: `#btn-save-draft` + classic `./classic/index.html` link
- Added decorative `.ambient` div (aria-hidden) and `<span>` inside `.brand-mark`; no JS dependency
- Classes `delight-body` / `delight-page` retained for any existing hooks

## Mobile considerations (≤720 / 390)
- Header: brand + auth row; actions grid `1.15fr 1fr 1fr 0.85fr` so **新建报销** stays visible
- ≤359px: 2×2 grid with 新建报销 full-width first row
- Tagline clamped to 2 lines on small screens (full text remains in DOM / title tooltips via native text)
- Stage labels still ellipsis; no intentional horizontal page overflow
- Sticky action bars use translucent gradient + light blur so glass ground shows through
- Toast lifted above thumb zone; modals sheet from bottom on narrow viewports
