---
topic: viewer-renderer-libraries-measured-costs-and-the-tree-emitting-stack
created_at: 2026-07-30T09:56:08.685876+00:00
updated_at: 2026-07-30T09:56:08.685876+00:00
---
**`docs/spec/viewer.md` 3.3 requires highlighted output be built as DOM nodes with `textContent`, never through a markup parser. An off-the-shelf stack satisfies that exactly, and picking a string-emitting highlighter instead is the reversal this entry exists to prevent.**

## The stack that satisfies the rule

- **`lowlight`** wraps highlight.js and, in its own README's words, "outputs objects (ASTs) instead of a string of HTML". It exposes `all` (±190 grammars) and `common` (37 grammars) so the grammar set is a build-time choice ([wooorm/lowlight](https://github.com/wooorm/lowlight)).
- **`hast-util-to-dom`** is a "hast utility to transform to a DOM tree" and "creates a DOM tree (defaulting to the actual DOM...)" ([syntax-tree/hast-util-to-dom](https://github.com/syntax-tree/hast-util-to-dom)).
- Together: bytes go highlight.js -> hast -> real DOM nodes, and no markup parser ever sees attacker input. `refractor` is the Prism-based equivalent.

## Measured sizes, 2026-07-30

Method: `curl` the package's own dist file from jsDelivr, `wc -c` for raw, `gzip -9 | wc -c` for compressed. Reproducible; not a bundler's output, and a real bundle differs.

| Package | version | raw | gzip -9 |
|---|---|---|---|
| `snarkdown` | 2.0.0 | 2,099 | 1,113 |
| `hast-util-to-dom` (esm entry) | 4.0.1 | 2,378 | 1,163 |
| `lowlight` (esm entry, deps external) | 3.3.0 | 17,748 | 3,811 |
| `unzipit` | 2.0.3 | 12,716 | 4,404 |
| `dompurify` | 3.4.12 | 29,209 | 10,698 |
| `marked` | 18.0.7 | 39,903 | 12,369 |
| `fflate` (umd) | 0.8.3 | 33,044 | 12,610 |
| `prismjs` core | 1.30.0 | 58,240 | 17,378 |
| `jszip` | 3.10.1 | 97,630 | 28,305 |
| `refractor` (esm entry) | 5.0.0 | 89,059 | 30,159 |
| `highlight.js` core + ~40 common grammars | 11.11.1 | 127,496 | 42,781 |
| `markdown-it` | 14.3.0 | 124,782 | 45,085 |
| `@zip.js/zip.js` | 2.8.34 | 118,004 | 55,983 |

Per-extra highlight.js grammar: python 1,569 gzip, typescript 3,195 gzip. **Caveat that must travel with these numbers: jsDelivr's `+esm` builds externalize dependencies**, so the `lowlight`, `refractor`, `hast-util-to-dom` and `shiki` figures are entry points only. Lowlight's real cost is lowlight plus highlight.js plus the chosen grammars. `shiki`'s entry measures small and its true cost is the Oniguruma WASM engine plus TextMate grammars, loaded separately.

## Two facts worth carrying

- **`dompurify@3.4.12` is current**, so `viewer.md` 3.1's requirement to pin past CVE-2026-41238 (fixed in 3.4.0) is satisfiable with the latest release rather than a fork or a backport.
- **Grammar loading is the real lever, not the library choice.** Core plus lazily-fetched grammars keeps the initial viewing-origin bundle small, and the highlighted-region cap routed to `shape` is about CPU, not bytes. They are separate decisions and get conflated.

## Media, and range-decryptable playback

Verified against `mdn/browser-compat-data`: `MediaSource` on `safari_ios` is `partial_implementation: true` with the note "Exposed in Mobile Safari on iPad but not on iPhone." `ManagedMediaSource` is `safari: 17` / `safari_ios: 17.1` and `version_added: false` on both Chrome and Firefox. So seekable streaming playback from a decrypted source has no single cross-browser API: iPhone needs `ManagedMediaSource` or a ServiceWorker synthesizing byte-range responses. In-browser playback runs from decrypted in-memory Blob URLs via native player elements, while seekable streaming from range-decrypted ciphertext remains a later capability and another reason the range-decryptable framing constraint is worth keeping.
