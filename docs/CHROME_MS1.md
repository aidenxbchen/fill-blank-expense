# Quiet application chrome (ms1)

Applied the supplied `docs/motionsites-brief/BRIEF.md` and reference notes, adapting MotionSites craft to this procurement SPA: one frosted-white navigation material, quiet metadata, no stacked glass slabs or promotional code.

- Header is the sole chrome surface: a floating rounded container with white 70% fill, 12px blur, and one soft rim. Existing brand, supplied face image, exact tagline and standalone 新建报销 remain.
- `#draft-save-status` and `#btn-retry-save` now live under the brand tagline inside the header. Their `.save-strip` wrapper remains for app.js state hooks, with plain muted text and no background, blur, border or shadow.
- `#stage-list` and all `.stage-item` elements now live at the start of `#main-content`, above the workflow title. The stepper is bare text / small numbered marks, with no glass slab. Ordered-list semantics, current-step state and IDs are retained.
- Modal background isolation continues to cover both relocated regions through the existing header/main inert handling; ui.js and all application/business code remain unchanged.
- Cache key for scripts, CSS and logo: `20261109ms1`.

Validation: existing UI / seven purchase-policy checks, JS syntax and unchanged HTML-ID set passed. Isolated synthetic Browser checks passed at 390px and 1200px: no page overflow; save status and stepper computed backgrounds transparent, backdrop-filter none, box-shadow none; save failure retry restored saved state; modal background inert and restoration remained correct. No real approval or message tests.
