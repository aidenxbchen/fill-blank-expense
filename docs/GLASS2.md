# REPORT glass2 — 报了么 iOS Liquid Glass

## User feedback (t51u)
- Tagline not 赵本山 style → exact short line
- Logo → Zhao Benshan funny photo
- Design/interaction → iOS / iPadOS liquid glass, silky motion, crisp content

## Changes
1. **Tagline** `#brand-tagline` → `发票放进去了，唠唠就完事了。`
2. **Logo** text「报」replaced with `assets/logo-zbs.webp` / `.png` inside squircle glass frame (cover, specular ring)
3. **Materials**
   - Chrome (header / stage-rail / menus / modals / toast): blur 28–40px, saturate ~1.7, translucent fills
   - Content `.panel`: higher opacity (`--surface` 0.86), lighter blur so text stays crisp
   - `--muted` raised to `#3d5169` for clearer tagline
4. **Motion**
   - `--ease-spring` / `--ease-out-soft` (iOS curves)
   - Hover lift + press `scale(.97)` (fine pointer only)
   - Modal/sheet `translateY` + opacity enter; stage panel light crossfade
   - Full `prefers-reduced-motion` kill; `prefers-reduced-transparency` solid fallbacks
5. **Cache** all asset queries `?v=20261109glass2`
6. Kept 报了么 + standalone `#btn-reset` 新建报销; no app.js logic touched

## Files
- `index.html`, `styles.css`, `REPORT-glass2.md`
- Logo assets already present under `assets/`

## Parent next
Copy to Mini, restart baoxiao, hard-refresh with `?v=20261109glass2`.
