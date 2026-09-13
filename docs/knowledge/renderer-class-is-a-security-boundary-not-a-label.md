---
topic: renderer-class-is-a-security-boundary-not-a-label
created_at: 2026-07-30T04:25:59.364721+00:00
updated_at: 2026-07-30T04:31:01.665153+00:00
---
The frame's eight-value renderer taxonomy (`markdown`, `code`, `html`, `jsx`, `image`, `media`, `archive`, `binary`) was introduced as telemetry. **It is a publisher assertion, and it must never route the viewer.** Every gap or misuse here is a potential key-disclosure path.

## CORRECTION to an earlier version of this topic

An earlier version of this entry concluded "the class selects the renderer, the sniff can only downgrade," and argued that was safe if the class lived inside the ciphertext where it is publisher-attested and tamper-evident under the AEAD tag. **That reasoning was wrong and the conclusion was dangerous.**

Publisher-attested means the *operator* cannot forge it. It does not mean it is *true*. A malicious publisher signs an honest-looking lie. Declaring `image` on an HTML payload wins inline rendering on the viewing origin, which is the origin holding the fragment secret, and the content reads `location.hash`. **That is the fragment-stealing attack in a single step, and it is what "the class selects" permits.**

The tamper-evidence argument answers the wrong threat. The threat is not the operator lying about the class; it is the publisher lying about it.

## The rule

**The class is telemetry and recipient-facing display copy on the unfurl card. It is still never a routing input, and the viewer never routes on it.**

Routing comes from magic-byte sniffing after decryption, treated as a hint that can only reach a *less* privileged path, plus the following disagreement rule:

**When the declared type and the sniffed type disagree, route to the least privileged path either type would allow, and tell the recipient you did so.** A file declared `.png` that sniffs as HTML is not rendered as an image (it is not one) and not rendered as HTML (HTML gets a separate origin, and the publisher did not declare it). It is download-only with a visible note that the contents do not match the name. One sentence, and it closes the entire polyglot class for the first release.

Privilege ordering, least to most: download-only, then sandbox origin, then viewing origin.

## SVG is download-only in the first release

SVG has no magic number and sniffs as XML or text, so it cannot be sniff-routed at all. Its execution is context-dependent: inert under `Content-Disposition: attachment` and inside `<img src>`, but inline, as `<object>`, or via direct navigation it **fully executes** (https://digi.ninja/blog/svg_xss.php). Real advisories from exactly this shape: Traccar GHSA-mc2g-mjqh-8x78, 2FAuth GHSA-q5p4-6q4v-gqg3, FileRise GHSA-35pp-ggh6-c59c, Plane GHSA-rcg8-g69v-x23j.

**A spec that says "still images render inline" without carving out SVG ships the CVE.** Sandbox-origin rendering for SVG is available later.

## Blob URLs inherit the creating origin

`URL.createObjectURL(new Blob([plaintext], {type: sniffedType}))` on the viewing origin creates a same-origin resource with an attacker-controlled MIME type. **Navigating to it executes on the origin that holds the key.**

- Never navigate to, and never open in a new tab, a blob URL built from untrusted plaintext on the viewing origin.
- Download blobs are always typed `application/octet-stream` and triggered via an `a[download]` attribute.
- Images render only via `<img src=blob:>`, where parsing is inert.

## Markdown is a partial HTML class

Markdown permits raw inline HTML, so rendering `markdown` on the viewing origin puts sanitizer output next to the fragment secret. DOMPurify has been bypassed at **default configuration** as recently as CVE-2026-41238 (3.0.1 through 3.3.3, https://labs.trace37.com/blog/dompurify-pp-ceh-bypass/). In strength order:

1. **Strip raw HTML from Markdown entirely in the first release**, or render Markdown on the sandbox origin exactly like HTML. Sanitization is the second layer and must never be the only one.
2. Pin DOMPurify at or above 3.4.0 regardless.
3. **Read the fragment once into a variable, then `history.replaceState` it out of the address bar**, so a sanitizer bypass finds no `location.hash` to read. Cheapest insurance in the viewer.

Markdown link and image targets are attacker-controlled too (`javascript:`, `data:`, remote images). A remote image is both an exfiltration channel and a beacon revealing that a specific relic was opened.

## Code and plain text: the safe class, two traps

Syntax highlighters take a language hint usually derived from the attacker-controlled extension, and some build HTML by string concatenation. Build highlighted output as DOM text nodes or sanitize it like Markdown, and fall back to plain text on an unrecognized hint. Separately, a "code" file can be many megabytes on one line, which hangs the highlighter and freezes the tab; cap the highlighted region and render the remainder as plain text behind a stated cutoff.

## Where the security headers actually matter

The object fetch goes client-to-GCS on a signed URL, so **the app server cannot set headers on it at all** (a direct consequence of ciphertext never transiting the app server). What GCS serves is ciphertext, indistinguishable from random and unsniffable into anything executable, so `nosniff` and friends guard almost nothing there. **The headers that matter are the viewing origin's own responses and the blob URLs the viewer creates.** Stating this stops a later station spending effort on bucket headers that guard nothing while skipping the viewer-side ones that guard everything.

## Related consequences

- **Reserved path segments.** With `/{id}` at the root, `/abuse`, the policy URL, and `robots.txt` are reserved words that must be excluded from the id alphabet, or an issued id can shadow the abuse page, the one page the preconditions make a go/no-go obligation.
- **The taskbar and content are on different origins by construction**, so the content iframe is never full-viewport and a relic authored to fill the screen renders letterboxed. Product-visible; state it before someone finds it in review.
- **Unknown class values fail to download-only**, never best-effort, so a client newer than the viewer degrades safely.
- **`postMessage` to the sandbox uses an exact target origin, never `"*"`.** A `postMessage` with target `"*"` carrying a decrypted relic hands the whole plaintext to whatever occupies that frame, which is worse than leaking one relic's key.
- **The filename is content, not a category, and storing it is now a conceded frame violation and a disclosed risk.** Server-side storage of it exceeds the frame's original telemetry leakage (`Q3-layoffs-final.xlsx` is not a coarse class, it reveals the subject of an encrypted file). The repo owner reversed the prohibition per `docs/decisions.md` so link unfurls can display a per-relic title (defaulting to the source filename) rather than a phishing-like blank card. This is a deliberate, conceded trade: the plaintext title is stored in the clear and disclosed in `/policy`. It remains the most sensitive metadata the server holds, exactly because a name like `Q3-layoffs-final.xlsx` leaks context before decryption.
- **The renderer class is now recipient-facing display copy as well as telemetry.** Emitting the class in the unfurl card's `og:description`, `twitter:description`, and fallback `<title>` gives the field a new audience: recipients before they click, rather than operators in telemetry alone. This does not change the routing boundary: `routeFor` in the viewer never consumes the class, so a publisher lying about the class misleads the preview card but cannot trick the viewer into escalating privilege. What changed is the viewing-origin boundary: the class is now in the document `<head>`, and the viewer's non-reliance on it is guarded by tests on the built viewer bundle rather than by total absence from the origin.
