# baoxiao Motionsites redesign brief (2026-11-09)

Source skill: https://github.com/Motionsites-AI/claude-skill (motionsites-web-builder)

## Product
报了么 SPA https://baoxiao.xbchen.top
Repo: /Users/chenxibin/Code/fill-blank-expense (this Mac mini). Do NOT edit Air.

## User complaint
两个玻璃条太丑、非常多余 = standalone `.save-strip` glass pill AND `.stage-rail`/`.stage-list` glass progress bar. Remove as two separate glass ribbons.

## Motionsites (SPA adaptation — work app, not video landing)
- One material reused; UI quiet; floating pill nav; liquid-glass hairline rim OR frosted-white sibling for light UI.
- Do not stack full-width glass slabs under the header.

## Required
1. Remove dual glass ribbons visually (save-strip bar + stage-list glass bar).
2. Keep `#draft-save-status` / retry save / stage `#stage-list` .stage-item behavior; relocate to quiet header-adjacent UI (muted text + compact stepper), not a second frosted slab.
3. Keep brand 报了么 + 本山 logo + tagline「发票放进去了，唠唠就完事了。」+ standalone「新建报销」+ all IDs.
4. Content cards stay readable; no Feishu/OCR/submit/logic changes.
5. Cache-bust `?v=20261109ms1`; commit; `./restart-local.sh`; do not push.

## Report
commit hash, files, how status+stages moved, restart confirm.
