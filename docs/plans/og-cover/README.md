# Per-relic cover images on the unfurl card

The architecture, contracts, slices and proof plan are in `plan.json` (planner output, 2026-10-13). This file records the owner's answers that the plan depends on. They are settled.

## Owner decisions (Jason Waldrip, 2026-10-13)

1. **Default on, opt-out.** `relic_publish` and `relic_republish` render a cover unless called with `cover: false`. Republishing with `cover: false` clears any stored cover.
2. **Legible first screen, full bleed.** The cover is a plain 1200x630 image of the top of the content as a recipient sees it. No Relic chrome, frame, label, title or filename.
3. **Every class is accounted for.** markdown, code, html, jsx, pdf: top of the first screen. image: cover-cropped. video: a representative frame. audio: embedded artwork, else a waveform. zip, tar, tar.gz, gzip: a rendered listing. The plaintext-cover leak is accepted.
4. **Local browser only.** Covers render in the publisher's installed Chrome, Chromium or Edge. No browser download. With none found, publish succeeds and reports the cover as skipped with the reason.
5. **Generic card stays for** plain binaries, archive formats whose listing is not cheaply readable (7z, rar, xz, zstd, bzip2), and WebP/ICO images the viewer routes to download.
6. **Mock gate.** The three new layouts (archive listing, audio artwork, audio waveform) are approved by Jason in `mockup.html` before the cover page build uses them.
7. **WebRTC egress finding** (Chrome 155 does not enforce the frame CSP's `webrtc 'block'`) is fixed in a separate, parallel PR, not here.
