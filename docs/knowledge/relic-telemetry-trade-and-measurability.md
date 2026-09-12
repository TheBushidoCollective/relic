---
topic: relic-telemetry-trade-and-measurability
created_at: 2026-07-30T02:38:18.659151+00:00
updated_at: 2026-07-30T02:50:10.201080+00:00
---
**A wedge nobody can measure is a wedge nobody can defend.** Relic's primary success metric is unmeasurable by default under its own architecture, and closing that gap costs a defined amount of metadata. Forced by adversarial review (`fb-01`, then sharpened by `fb-03`) at the frame station. Overridable by the operator.

## The problem

The primary metric is a conjunction: relics get opened by someone other than the publisher, **and** opened relics are predominantly types Relic *renders* rather than download-only binaries. The second clause is what distinguishes Relic from a worse file.kiwi.

Neither half has a path to a number by default:
- The server holds only ciphertext and never receives the key, and mimetype sniffing happens **after decryption, in the browser** (see [[archive-browsing-and-mimetype-detection]]).
- The viewing origin carries no analytics or error reporting, because any same-origin script can read `location.hash` (see [[rendering-untrusted-content-origin-isolation]]).
- The server cannot distinguish a recipient's open from the publisher's own confirmation open, so during dogfooding the metric reads green in exactly the world where Relic has zero recipients.

Left unfixed, "opens by rendered type" silently degrades to "opens," which is trivially observable from the signed-URL mint and is precisely the number that cannot detect the failure it exists to detect. The instrument becomes the thing that hides the problem.

## The telemetry

Minimum required to make the metric computable, all **server-side**, none from a script on the viewing origin:

1. **A coarse renderer class declared at publish time by the local client**, which already holds the plaintext: one of `markdown`, `code`, `html`, `image`, `media`, `archive`, `binary`. Stored against the relic ID.
2. **Open counts taken at signed-URL mint time.**
3. **Publishing client name**, so "does this serve the segments Artifacts cannot" is answerable at all.
4. **An optional publisher-declared plaintext title** (defaulting to the source filename), stored server-side to populate link preview cards and viewer titles (`og:title`), reversing the prior rule that the server stores no title or filename per `docs/decisions.md`.
**Why the class supports a claim about *opened* relics, not just published ones:** the class is stored against the relic ID, every open event names that ID, so joining them yields the class distribution of the opened population directly. The class is immutable for the relic's life, because republish-to-same-URL and versioning are non-goals, so one relic has exactly one plaintext and therefore exactly one true class. Nothing drifts between publish and open. The taxonomy also cuts exactly on the wedge boundary: renderable is `{markdown, code, html, image}`, download-only is `{media, archive, binary}`.

## The publisher-versus-recipient confound is PERMANENT. Do not treat it as solved.

**This is the correction from `fb-03`. An earlier version of this topic asserted "excluding opens originating from the publishing IP" as a clean mechanism attached to item 2. That was wrong, and the error is instructive.**

Publishing-IP exclusion fails **asymmetrically**, in the direction that hides a loss:
- **Same-NAT is the safe direction.** A genuine recipient behind the publisher's NAT gets excluded, undercounting recipient opens. This can only make you believe you lost when you won. Acceptable.
- **The publisher on any other IP is the dangerous direction.** Cellular, VPN, a second machine, a coffee shop: the publisher's own open counts as a recipient and inflates the exact clause the metric rests on. Not a corner case for this product, since Relic ships a PWA whose point is mobile viewing, and checking your own link before sending it is the most likely thing a publisher does. In the zero-recipient failure world, a publisher who habitually checks on a phone produces a first clause reading near 100 percent.

**No mechanism available under the locked non-goals fully separates publisher from recipient.** Accounts would, and accounts are a non-goal, so the residual confound is permanent and must be **documented rather than engineered away**. What is required instead:
1. State the asymmetry with both directions named. Never present the first clause as a clean number.
2. Name a concrete discriminator for the dominant false positive, computable server-side (a short post-publish exclusion window is the cheap one, since the self-check is overwhelmingly immediate; a time delta between publish and mint qualifies, anything needing a viewing-origin script does not).
3. **State what that discriminator fails to catch.** A short window misses a publisher who checks twice, or who checks from a phone after sending the link, and it eats a genuine first recipient open when the publisher never self-checks. An undocumented failure direction is worse than a known one.
4. State the trust condition: below what volume or during what period the number is not informative. Early low-volume operation with the collective as publisher is when self-checks dominate the sample.

**Two scope limits on the confound.** It touches only the first clause. The second clause (renderable versus download-only) is substantially robust to publisher self-opens, because a publisher self-checks relics drawn from the same publishing population, so the failure it exists to detect still shows through. The sharpest half of the metric is the half the confound damages least. Separately, the telemetry measures the *type* of what was opened, never whether rendering succeeded; render success would need a viewing-origin script, so it is out of reach by design.

## The cost, stated plainly

This leaks a coarse content category, an optional publisher-declared plaintext title (defaulting to the source filename), a client name, and IP-correlated open activity to the operator. The title is stored in the clear to populate link unfurls, while the content stays encrypted and the operator still cannot read a byte of the file itself. But it is a real reduction from "the operator knows nothing" to "the operator knows what kind of thing you published, its declared title or filename, and roughly how often it was fetched." It must appear in a published privacy statement. Per [[abuse-liability-of-hosting-uninspectable-content]], upload IP and timestamp are already retained for abuse response, so the IP-correlation cost is largely pre-existing.

**This does not conflict with the no-analytics rule on the viewing origin.** Every item is captured by the server at publish or at signed-URL mint. No script runs on the viewing origin to produce any of it. Do not read this decision as license to add one.

## The general principles for later stations

1. **A success metric that cannot be computed under the architecture that produced it is not a metric, it is a wish.** When a station locks a constraint that makes a metric unmeasurable, the station owning the metric must either state the telemetry that restores measurability and its cost, or change the metric. Silently keeping the unmeasurable metric is the failure mode.
2. **A mitigation with an undocumented failure direction is worse than no mitigation**, because it converts a known unknown into false confidence. Whenever you name a mechanism that partially solves a problem, name what it misses in the same breath. Apply this recursively: it is what turned "add a discriminator" from an unfalsifiable instruction into a checkable one.
