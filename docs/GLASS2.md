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
   - Pointer hover lift + press `scale(.97)` on both pointer and touch
   - Modal/sheet `translateY` + opacity present/dismiss (native discrete-display transition where supported; older engines retain entrance-only fallback); stage panel light crossfade
   - Full `prefers-reduced-motion` kill; `prefers-reduced-transparency` solid fallbacks
5. **Cache** all asset queries `?v=20261109glass2`
6. Kept 报了么 + standalone `#btn-reset` 新建报销; no app.js logic touched

## Files
- `web/index.html`, `web/styles.css`, `docs/GLASS2.md`
- Logo assets already present under `assets/`

## Parent next
Work completed in the existing Mini checkout. Restart with `restart-local.sh --managed`, then hard-refresh with `?v=20261109glass2`. Both image sources also carry the glass2 cache key. No push requested. All original element IDs and app.js business logic preserved.

## Mini verification
- UI hooks/duplicate-click/error-recovery tests and seven purchase-method policy tests passed; 102 backend unittest cases passed. All original HTML IDs retained.
- Isolated synthetic Browser fixture verified the supplied logo decodes, exact tagline, standalone new action, 390px / 1200px layout without page overflow, and modal focus restoration. Native discrete transitions are supported by this Browser; closing settles to display:none. Reduced-motion and reduced-transparency fallbacks remain. No production approval or message was created.
