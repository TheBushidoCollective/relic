---
topic: link-preview-and-unfurl-behavior-by-client
created_at: 2026-07-30T09:55:02.216486+00:00
updated_at: 2026-07-30T09:55:02.216486+00:00
---
**What every major chat and mail client actually does when a Relic link is pasted.** This is observable vendor behavior, not opinion, and it decides whether an unfurl burns a mint, a download-cap unit, or egress. `docs/spec/service.md` section 2 rests the "no mint on `/{id}`" rule on it.

## The three architectures (primary research: Mysk, tested on real apps)

Talal Haj Bakry and Tommy Mysk classified every major messenger by where the preview fetch originates ([Mysk](https://mysk.blog/2020/10/25/link-previews/)).

- **No preview at all:** Signal (preview option off), Threema, TikTok, WeChat.
- **Sender's device fetches** ("Approach 1"): **iMessage, Signal (preview on), Viber, WhatsApp.** The publisher's own machine hits `/{id}`, not the recipient's.
- **Vendor servers fetch** ("Approach 3"): **Discord, Facebook Messenger, Google Hangouts, Instagram, LINE, LinkedIn, Slack, Twitter, Zoom.**

Per-client download ceilings they measured: "Discord: Downloads up to 15 MB of any kind of file.", "Slack: Downloads up to 50 MB of any kind of file.", "Twitter: Downloads up to 25 MB", "Zoom: Downloads up to 30 MB", "LINE: Downloads up to 20 MB", "Google Hangouts: Downloads up to 20 MB", "LinkedIn: Downloads up to 50 MB". Facebook Messenger and Instagram had no ceiling: Instagram "servers will download anything no matter the size", and Facebook told them "they consider this to be working as intended."

## The JavaScript question, which is the one that matters

Most previewers are plain HTTP fetchers and never run the shell's script, so they never mint. The exceptions:

- **Mysk found two servers executing JavaScript: Instagram and LinkedIn.** "We were able to confirm that we had at least 20 seconds of execution time on these servers." A JS-executing previewer runs the shell, mints a signed URL, and (on Instagram's unbounded fetcher) can pull the whole ciphertext object.
- **iMessage is believed to run a full WebKit engine on the sender's device, and this is NOT vendor-documented.** Apple's `LPMetadataProvider` docs describe only fetching metadata and a `shouldFetchSubresources` flag. A practitioner writeup states, hedging in its own words, "Internally it seems to spin up a WKWebView to receive the metadata" ([Teabyte](https://alexanderweiss.dev/blog/2023-04-16-lpmetadataprovider-extract-url-metadata)). Treat as unresolved and settle it empirically.

## Slack, documented in its own words

From [api.slack.com/robots](https://api.slack.com/robots): the fetcher is `Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)`; "It fetches as little of the page as it can (using HTTP Range headers) to extract meta tags about the content."; "If a page's tags refer to an image, video, or audio file, we will fetch that file as well to check validity and extract other metadata."; "Responses to these requests are cached globally across the service for around 30 minutes."; "We do not currently honor robots.txt files." Separately, [Slack's unfurl docs](https://docs.slack.dev/messaging/unfurling-links-in-messages/) state "Our servers must fetch every URL in a message to determine what kind of content it references."

Two consequences: **Open Graph tags must sit early in the shell's `<head>`**, because Slack range-fetches the head of the document; and **the constant `og:image` gets fetched too**, so it is real recurring egress on the service origin (bounded by the 30-minute global cache).

## User-Agent is provably not a discriminator

Signal's Android client fetches link previews through OkHttp with `.addInterceptor(new UserAgentInterceptor("WhatsApp/2"))`, plus `FAILSAFE_MAX_TEXT_SIZE` and `FAILSAFE_MAX_IMAGE_SIZE` of 2 MB each ([LinkPreviewRepository.java](https://raw.githubusercontent.com/signalapp/Signal-Android/main/app/src/main/java/org/thoughtcrime/securesms/linkpreview/LinkPreviewRepository.java)). A major client deliberately impersonates another. Any control keyed on User-Agent is decorative.

## Teams

Link unfurling is app-registered per domain and "The link unfurling result is cached for 30 minutes" ([Microsoft](https://learn.microsoft.com/en-us/microsoftteams/platform/messaging-extensions/how-to/link-unfurling)). Registering a Teams app for the relic domain is an available lever for controlling the card; it is not required.

## Gmail

No Google documentation was found describing Gmail fetching arbitrary linked URLs to build a card. What is documented is image proxying and pre-delivery scanning: "Google scans images for signs of suspicious content before you receive them" ([Gmail help](https://support.google.com/mail/answer/145919)). Record this as "no documentation found", never as "does not happen."

## What follows

1. **The fragment never reaches any of them.** Fragments are not sent in HTTP requests, so no unfurler can ever describe relic content. That fact is unchanged and load-bearing. While the server cannot decrypt content to populate a card, it can serve metadata declared in the clear at publish time: `og:title` carries a publisher-declared plaintext title (defaulting to the source filename) or a per-class fallback, `og:description` reveals the coarse renderer class, and the image, type, and site name remain constant (reversing the prior all-constant rule per `docs/decisions.md`).
2. **A browser-grade previewer defeats the static-shell rule.** `service.md` concedes "a scanner that detonates with a real browser does run it." Instagram, LinkedIn, and probably iMessage are that scanner. The per-object download cap and the egress arithmetic need a term for it beyond the Safe Links 40-to-80 figure.
3. **The mitigation nobody has priced: gate the mint on a signal a headless previewer does not produce** (a real user gesture, or visible-and-focused). It costs the recipient friction in exactly the first five seconds the wedge depends on. Real fork, not a free win.
4. **One empirical test settles the whole matrix.** `service.md` section 6 already mandates a pre-launch Safe Links test. Widen it: publish one relic, send it through every target channel, read the server log. Cheap, and it answers what no vendor documents.
