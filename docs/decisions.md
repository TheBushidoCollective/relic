# Relic: the build decisions

`docs/frame.md`, `docs/preconditions.md`, and everything under `docs/spec/`
are locked inputs. Each of those documents routes a short list of open picks
forward. This file makes those picks and records why, so no value in the code
is a number nobody can account for.

Nothing here reopens a locked decision. Where a pick is constrained by a
locked rule, the rule is cited rather than restated.

## From `spec/format.md` section 4

### 1. Wire format and framing

**RFC 8188 `aes128gcm`, unmodified.** It was presumptive in the spec and
nothing displaced it. It satisfies all four required properties: range
decryption, per-record AEAD, plaintext size derivable from encrypted length
before decryption, and a header readable before allocation.

**`rs` is 65536.** Record size bounds the envelope header, which must fit in
record 0 alone (`format.md` 3.1). The maximum header this build can emit is
1301 bytes, so 64 KiB leaves the caps room to grow through a version bump
without touching the framing. It is also a sane GCS byte-range unit: a range
request for one record costs one 64 KiB read.

**The envelope header field caps follow from `rs`:** filename at 1024 bytes,
declared mimetype at 255 bytes, both measured as UTF-8 bytes rather than
characters.

**Record 0 is padded to full `rs`.** RFC 8188 permits only the final record
to be short, and record 0 carries only the envelope header, so it is padded
with the framing's own delimiter-plus-zeros mechanism. This is the
"discretionary padding" case `format.md` 3.3 anticipates: the pre-decryption
size derivation is an upper bound, which is the safe direction for a
refuse-before-allocating check. The exact content length arrives in the
envelope header's per-entry `length` a moment later.

The consequence worth naming: record boundaries stay at fixed offsets, so
content plaintext byte `n` always lives in record `floor(n / (rs - 17)) + 1`.
Range decryption is arithmetic, not a search.

### 2. Key length

**128 bits.** RFC 8188 `aes128gcm` derives a 128-bit content-encryption key
through HKDF regardless, so a longer input keying material buys nothing the
framing can use. 16 bytes is 22 unpadded base64url characters.

The `fragment-terminal-charset` check `format.md` 2.3 requires holds by
arithmetic: 16 is not a multiple of three, the final character carries 2
significant bits, so its index is a multiple of 16 and can only be `A`, `Q`,
`g`, or `w`. Neither `-` (62) nor `_` (63) is reachable, and none of the four
is in GFM's trailing-punctuation set. The check is implemented both ways in
`packages/relic-format/test/fragment.test.ts`.

### 3. ID entropy

**128 bits, 26 Crockford base32 characters.** The floor is 122 bits
(`format.md` 1.2). One 16-byte CSPRNG draw encodes to 26 characters at 5 bits
each, giving 130 bits of capacity carrying 128 bits of entropy.

26 characters clears the reserved-word length guard by six: the longest
reserved word is `manifest.webmanifest` at 20 (`format.md` 1.5).

### 4. The cap, and which side it lands on

**100 MiB, enforced on plaintext.** `format.md` 3.11 requires the published
number be one a user can verify with `ls`, and enforcing on the side that is
published removes the conversion entirely. `size_basis` is therefore
`plaintext` in every `size_over_cap` problem document.

The grant signs a ciphertext constraint computed as
`encryptedSize(104857600)`, so a file exactly at the published cap always
fits, which is the failure 3.11 exists to prevent.

### 5. Bucket padding

**No.** `format.md` 3.8 frames the trade: padding is paid in egress on every
fetch by every recipient forever, against a precondition that names egress as
a kill-switch condition, and what it prevents is a size estimate the operator
gets a coarse version of regardless.

Declining it also keeps the plaintext-size derivation exact for the content
records, so the only slack in the derivation is record 0's padding, which is
a known constant rather than a variable.

The length leak appears in the published disclosure statement, as
`format.md` 3.8 requires under either branch.

### 6. Object metadata at upload

**None is set.** `format.md` 3.2 already bars anything content-descriptive
from object metadata, and section 4 item 6 asks only whether any is needed at
all. Nothing needs it: the renderer class, the client name, and the optional
publisher-declared plaintext title go to the app server in the grant request body
and live on the relic row, and the CRC32C the mint response returns is
non-editable metadata GCS computes on its own.

So the grant signs no `x-goog-meta-*` header, and the blocklist scanner reads
object bytes only.

## From `spec/service.md` section 7

### 1. Edge fidelity

The app server emits every status and problem document in `service.md`
section 1 itself. The degradation contract for load shedding is implemented
as specified: a bare `429` reads as `mint_rate_limited` or
`publish_rate_limited` by endpoint, a bare `503` as `service_paused`.
Asserting this against a deployed edge under load is a launch check, not a
unit test, and it is not claimed as done here.

### 2. Per-object download cap

**200 mints.** The binding constraint is `service.md` 2.3: a 40-person
distribution list inside a Defender tenant draws a floor of 40 legitimate
mints and a ceiling near 80 where scanners detonate with a real browser. 200
clears the ceiling by 2.5x, which leaves room for the same relic to be
forwarded once without dying.

Worst-case egress per relic is 200 x 100 MiB, which is 20 GiB, or $2.40 at
$0.12/GB. That is the number the kill-switch ceiling is set against.

The pool is per relic id across every version: republishing adds an object,
never a second pool (`format.md` 3.12), so the 20 GiB ceiling per id survives
versioning. What versions multiply is storage, up to 100 MiB per version,
kept until deleted.

### 3. Expiry

**No operator TTL. A publisher may set a lifetime, capped at 3650 days;
absent one, the relic never expires.** This reverses the original 7-day pick
and the locked rule it rode in on, and the reversal is recorded rather than
absorbed. The storage-side Delete rule is gone because a bucket-wide rule
cannot express a per-relic lifetime and would have deleted ciphertext the
publisher asked to keep, so expiry is enforced only by the application, at
mint, exact to the second (`service.md` 3.1).

The cap is `config.maxTtlDays`, the accepted ceiling for a publisher-supplied
`ttl_days` in the grant request rather than a recommendation. A relic with no
lifetime has no expiry arithmetic at all: the mint path performs no expiry
refusal and the signed URL validity runs unclamped. The cost of the reversal
is the old rule's whole value: no storage-side reaping exists, an expired
relic's bytes outlive its refusal until explicitly deleted, and the abuse
controls that remain are delete-by-ID, the download cap, and the kill switch.

### 4. Signed-URL validity

**15 minutes, with a minimum viable validity of 60 seconds.** Long enough for
a 100 MiB download on a slow connection, short enough that the residual drain
after the kill switch engages is bounded by 15 minutes of already-minted
URLs.

A mint that would clamp below 60 seconds is refused with `relic_expired`
rather than issuing a URL that dies mid-transfer (`service.md` section 3).
Clamping only exists on a relic with a publisher-set lifetime; one without
never clamps and never returns `relic_expired`.

### 5. Retention window

**30 days.** `service.md` 7.5 names the failure a shorter window causes: the
metric's publishing-IP filter silently stops firing on older relics. It also
bounds how long the tombstone and the mint log's `code` survive, which the
cap-exhaustion cost in 1.2 depends on. It was originally set longer than a
7-day TTL; with no TTL, a relic that never expires can outlive the window,
and the accepted consequence is that the relic row keeps serving after its
mint-log history has aged out.

### 6. Published SLA

**24 hours from arrival, not from triage.** Google publishes no suspension
timeline beyond "timely", so the number has to be same-day-safe across the
named human's timezone and their named backup.

The coverage limit `service.md` 4.1 states travels with the number wherever
it is published: this measures responsiveness on reports received, and it is
never coverage.

### 7. Mint dedup interval

**10 minutes.** It has to exceed the frame's 120-second post-publish window
or the two rules interact, and it has to be short enough that a recipient
returning to a relic later in the day counts as the distinct open it is.

## From the owner, on the usercontent frame's egress

### 1. No network reach for rendered content

**2026-08-18: reversed. The usercontent frame has no network reach,
enforced by the frame's response policy rather than disclosed as a
capability.** The earlier decision, recorded in `spec/viewer.md` 3.5 and 4
and in the frame's second honesty constraint, was parity: rendered content
kept the network reach HTML has always had, a component could fetch
whatever its author wrote, and the recipient was told their IP address,
user agent, and open time could be learned that way. The owner reversed
it: bundle those assets and never fetch them from a CDN, and nothing
outside Relic's own host is allowed.

The mechanism is a CSP on the frame's served response that permits no
remote source of any kind, an iframe carrying `allow-scripts` and nothing
else, and React bundled into the frame's inlined bundle. Inlining is the
only option for that last part, and the reason is structural: the frame is
sandboxed without `allow-same-origin`, so it runs in an opaque origin, and
in an opaque origin `'self'` matches nothing. The frame cannot fetch even
its own assets, so "bundled from our host" can only mean inlined into the
`sandbox.html` response Relic already serves. There is no fetchable middle
ground.

What was traded away, named: a published page that references a CDN
stylesheet, a CDN script, an external font, or a remote image renders
without it, and publishers must inline what their page needs. A component
that reads from an API at render time is no longer expressible. That is a
real reduction in what a relic can be, and it was chosen anyway.

The enforcement is measured, not argued. With the policy in place, `fetch`,
`<img>`, `sendBeacon`, `WebSocket`, and `EventSource` all produced zero
arrivals at a collector server. `sendBeacon` returned `true` while
delivering nothing, so its return value is not evidence. A form with
`target=_blank` submitted and never arrived, blocked by `form-action
'none'`. `window.open` was blocked in the probe, but no user gesture was
present, so the policy is not what stopped it; popups are removed by
dropping the `allow-popups` sandbox flag instead.

## What is not decided here

These are launch obligations, not build decisions, and the build does not
claim them:

- The two registrable domains, and Search Console verification on both
  (`preconditions.md` section 2). The build runs against placeholder names.
- The pre-launch Safe Links fragment test (`service.md` section 6). Until it
  runs, the disclosure statement's wording stays correct under all three
  possible outcomes.
- The named abuse-response human and their backup
  (`preconditions.md` section 1).

## 2026-08-18: Pre-render statement demoted to a compact marker

The pre-render statement in the viewer (previously a banner above the content) was demoted to a compact marker in the header chrome. Its original justification was that rendered content could reach the network, allowing the author to learn the recipient's IP, user agent, and open time. Since that egress was removed by the strict CSP applied to the frame, the risk described by the banner is gone. A banner shouting about a removed risk trains recipients to ignore real ones. The page now carries a quiet marker in the header chrome stating "Runs author code, isolated" (linked to `/policy` for the full statement) rather than a block layout banner.

## 2026-09-12: Open Graph card metadata and per-relic plaintext title

`docs/spec/viewer.md` §6.2 originally ruled that Open Graph and Twitter Card metadata was identical for every relic, asserting that "a per-relic value would either be a fabrication or a leak," and `docs/spec/format.md` §3.2 treated server-side storage of a filename as a frame violation.

**The repo owner authorised an explicit reversal of that rule.** The blank preview card produced on link unfurls on unfamiliar domains presented the visual shape of a phishing link, creating recipient distrust before the relic could ever be opened. To solve this, a per-relic plaintext title is now permitted.

**What stays constant and what becomes per-relic.**
- `og:image`, `og:description`, `og:type`, and `og:site_name` remain constant across all relics. `og:type` is `website`, `og:site_name` is `Relic`, and `og:description` is the constant text: "An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it."
- `og:title` and the viewer document `<title>` carry the publisher-declared plaintext title (defaulting to the source filename). When titled, `<title>` renders as `{title} · Relic` (using a U+00B7 middle dot, never a dash). When untitled, the fallback title is `A relic` for `og:title` and `twitter:title`, and `Relic` for `<title>`.
- `og:url` carries `{serviceOrigin}/{id}` when the path segment is a valid relic id, or the service origin root otherwise.
- Twitter Card tags mirror their Open Graph equivalents: `twitter:card` is `summary_large_image`, with `twitter:title`, `twitter:description`, and `twitter:image`.

**Image asset path and cache policy.**
The preview card image is served from `/assets/card.v1.png` (a 1200x630 PNG, located in `packages/relic-viewer/public/card.v1.png`). Cache policy is the single exception to the server's blanket `no-store`: `cache-control: public, max-age=31536000, immutable`, alongside `referrer-policy: no-referrer` and `x-content-type-options: nosniff`. Versioning lives in the filename so future asset designs can ship as `card.v2.png` without cache collisions. The image is never gzipped.

**Disclosure obligations and security invariants.**
- Storing the title in plaintext on the relic row is an acknowledged metadata leak. The published disclosure statement (`/policy` per `docs/spec/service.md` §5) must explicitly state that the publisher-declared title is stored server-side in the clear and served on link unfurls and the viewer document `<title>`.
- Declining the title is the publisher's choice, not the operator's: a publisher can pass an empty title or clear it on republish, reverting to the constant fallback metadata.
- Tombstoned, expired, unknown, or malformed relics stop serving the stored title immediately, serving the constant fallback metadata (`A relic`).
- Serving metadata on `/{id}` continues to mint nothing, increment no open counters, and consume no download cap.
- The `X-Robots-Tag: noindex` header and `robots.txt` disallow posture remain intact on `/{id}`: unfurlers parse Open Graph tags regardless, while compliant search indexers do not index.

## 2026-09-13: Open Graph card reveals coarse renderer class

The unfurl card introduced yesterday (PR #69) revealed a relic's title but said nothing about what kind of thing it was: the description remained one constant sentence for every relic. The owner's steer: "relics should still reveal WHAT they are in the OG. Just not the content."

**The coarse renderer class on the card.** The service already holds the coarse renderer class on the relic row (`markdown`, `code`, `html`, `jsx`, `image`, `media`, `archive`, `binary`), declared at publish time and previously used only for server-side telemetry. The card now reveals this class in its description and fallback title.

**What stays constant and what becomes per-class.**
- `og:image` remains the single constant raster at `/assets/card.v1.png` (with its constant dimension and alt tags). `og:type` (`website`), `og:site_name` (`Relic`), and `twitter:card` (`summary_large_image`) remain constant. The one-raster budget on the service origin and the immutable cache policy (`public, max-age=31536000, immutable`) stay intact.
- `og:description` and `twitter:description` now reveal the coarse renderer class. The copy combines a phrase naming the kind of thing, one space, and a tail split strictly by `isRenderable` from `@relic/format`:
  - `markdown`: "A Markdown document. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it."
  - `code`: "A source code file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it."
  - `html`: "An HTML page. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it."
  - `jsx`: "A JSX component. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it."
  - `image`: "An image. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it."
  - `media`: "An audio or video file. It downloads to your device, and only someone holding the whole link, including the part after the #, can open it."
  - `archive`: "An archive. It downloads to your device, and only someone holding the whole link, including the part after the #, can open it."
  - `binary`: "A binary file. It downloads to your device, and only someone holding the whole link, including the part after the #, can open it."
- `og:title`, `twitter:title`, and the viewer `<title>` use the publisher-declared plaintext title when present. When untitled, the fallback title is now per class:
  - `markdown`: `A Markdown relic`
  - `code`: `A code relic`
  - `html`: `An HTML relic`
  - `jsx`: `A JSX relic`
  - `image`: `An image relic`
  - `media`: `A media relic`
  - `archive`: `An archive relic`
  - `binary`: `A binary relic`
- For an untitled relic, the document `<title>` renders as `{Class} relic · Relic` (using a U+00B7 middle dot, never a dash).
- When a relic is unknown, tombstoned, expired, or malformed, or if a store read fails, it serves the constant fallback metadata: `A relic` for `og:title` and `twitter:title`, `Relic` for `<title>`, and `An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.` for `og:description` and `twitter:description`.

**Declining a title does not hide the class.** The title is publisher-declared and declinable: a publisher can pass an empty title or clear it on republish. The class is derived from the decrypted bytes by the publishing client and is not declinable.

**Converting the format.md 3.6 boundary from an absence into a tested guard.**
- `docs/spec/format.md` §3.6 originally argued that the renderer class must never reach the viewing origin, keeping it out of reach to prevent fragment theft if the viewer ever routed on a publisher-asserted class.
- Emitting the class in `/{id}`'s head as card metadata puts the class on the viewing origin's document for the first time.
- The container still does not carry the class. What actually protects routing is `routeFor`'s inputs in `packages/relic-viewer/src/viewer.ts` (`filename`, `declaredMimetype`, `content`), which derive strictly from the envelope header inside the AEAD plus magic-byte sniffing of the decrypted content, resolving disagreements to the least-privileged tier. The class is not a parameter of `routeFor`, so routing on it would require a signature change rather than a silent edit.
- The absence of the class from the origin was a second, weaker belt, and this change spends it deliberately so recipients can see what kind of thing a link holds before opening it.
- The replacement guard is a test on the built viewer bundles ensuring they never read the card metadata from the DOM. A tested boundary is weaker than an architectural impossibility, and the project documents that trade honestly.
