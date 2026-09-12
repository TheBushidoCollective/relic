# relic-mcp

Publish a file as an encrypted relic and get back a shareable link. The
encryption key is generated on your machine and is never sent to the service.

```bash
claude mcp add relic \
  --env RELIC_SERVICE_ORIGIN=https://relik.link \
  -- npx -y relic-mcp@latest
```

Then: *"publish ./report.md as a relic."*

For any client that takes a JSON config:

```json
{
  "mcpServers": {
    "relic": {
      "command": "npx",
      "args": ["-y", "relic-mcp@latest"],
      "env": { "RELIC_SERVICE_ORIGIN": "https://relik.link" }
    }
  }
}
```

## What it does with your file

1. Reads it from disk, in this process. It is never sent anywhere in plaintext.
2. Draws a 128-bit key and a 26-character relic id independently from your
   machine's CSPRNG. Neither derives from the other.
3. Encrypts locally with AES-128-GCM under RFC 8188 `aes128gcm` framing.
4. Uploads **only ciphertext**, straight to object storage under a signed URL.
   It does not pass through the Relic service.
5. Tells the service four things: a coarse renderer class from an eight-value
   list, this client's name, the ciphertext's byte length, and the title,
   which defaults to the filename and is stored in the clear. Not the
   mimetype, not the contents.
6. Records the relic's id, key, and publish token locally, in a 0600 file
   under your user config directory, so the relic can be republished from
   this machine later. See [Republishing](#republishing). The service never
   receives the key or the token plaintext; it keeps only a SHA-256 of the
   token.

Call the `relic_describe_client` tool and it will tell you all of this itself,
without reading a file or making a request.

## What it does not protect against

The tool returns the full URL, and the key lives in that URL's fragment,
because handing you a usable link is the point. **So the key enters your
model's context and your session transcript on every publish.** Zero-knowledge
holds against the Relic operator. It does not hold against your model provider
or whoever stores your transcripts. That is structural, not a defect awaiting
a fix.

## Republishing

`relic_republish` publishes a new version of a relic this machine originally
published: same id, same key, **same share URL**. Everyone holding the
existing link sees the new content; there is no new link to hand out.

```json
{
  "name": "relic_republish",
  "arguments": { "relic_id": "0a2c...", "path": "./report-v2.md" }
}
```

It takes `relic_id` (the 26-character id the original publish returned) and
`path`, plus optional `filename` and `title` overrides and an optional
`ttl_days` that is forwarded on the request. Versions count from 1:
`relic_publish` reports
version 1, each republish reports the next number, and the URL never changes
across them. A relic's lifetime is fixed at its first publish and carries
across versions.

Republishing needs the relic's key and its publish token, so the first
`relic_publish` records both in a local state file:
`$XDG_CONFIG_HOME/relic-mcp/publish-state.json` by default
(`~/.config/relic-mcp/publish-state.json` when `XDG_CONFIG_HOME` is unset),
created `0600` inside a `0700` directory, and redirectable with
`RELIC_PUBLISH_STATE`. Consequences worth stating plainly:

- **Only that machine can republish.** Anywhere else, the tool refuses: the
  relic was published from another machine and cannot be republished here.
  Copying the state file to another machine moves the ability with it.
- **The file holds the key and the token.** They are never printed, logged,
  or returned by any tool result. The service stores only a SHA-256 of the
  token, so it cannot reconstruct either one.
- **Losing the file changes nothing for existing links**; it only ends that
  machine's ability to update those relics.
- **A takedown is permanent.** A removed relic answers `relic_removed`
  (HTTP 410) forever, whatever token is presented, and republishing cannot
  revive it. Publish the content as a new relic instead. A rejected token is
  its own refusal (`invalid_publish_token`, HTTP 403): the local record no
  longer matches the service's, and the relic cannot be republished from
  this machine, though it can still be read.

## Comments

People can comment on a relic, and comments are the only channel back: there
is no reply-to and no dashboard. `relic_read_comments` reads them, oldest
first, decrypting on this machine.

```json
{
  "name": "relic_read_comments",
  "arguments": { "relic_id": "0a2c..." }
}
```

`relic_comment` writes one, encrypted here before it leaves:

```json
{
  "name": "relic_comment",
  "arguments": { "relic_id": "0a2c...", "body": "Fixed the chart." }
}
```

Both take the relic id and refuse a share URL, because the URL carries the key
in its fragment and passing it would put the key in your transcript again for
nothing. Both work only on the machine that published the relic: the comment
key is derived from that relic's key with a distinct HKDF label, and the key
lives in the same local state file as the publish token.

A human commenter verifies an email address through a magic link, and that
address is their identity. This client has no mailbox, so its comments are
authorized by the publish token and attributed as `publisher`; an optional
`display_name` labels them and never replaces the attribution. A comment that
does not decrypt is returned marked unreadable with a count, never dropped,
because a quietly shortened list reads as agreement.

What the service holds is comment ciphertext it cannot read. What it learns is
who commented on which relic and when, which for a human commenter is a
verified email address. The content stays private; the participation does not.

## Why it runs locally

Encryption has to happen where the plaintext is, so a hosted version of this
would have to receive your file, which defeats the point. Nothing here is
fetched from the network and executed.

Because a local client is otherwise opaque, it ships as **readable source
rather than a compiled binary**. `dist/relic-mcp.js` is a single unminified
file and it is exactly what runs; the TypeScript it was built from is in the
same package. Releases carry npm provenance, a cryptographic attestation
binding the tarball to a specific commit and workflow.

## Tools

| Tool | Input | Notes |
|---|---|---|
| `relic_publish` | `path`, optional `filename`, `title`, `ttl_days` | A filesystem path. Inline content is deliberately not accepted, so the plaintext never joins the key in your transcript. A relic carries a plaintext title defaulting to the filename and stored by the service in the clear for link previews; pass `""` to publish without one. A relic is kept until it is deleted; `ttl_days` (an integer, 1 to 3650) gives it a lifetime. Reports the relic as version 1. |
| `relic_lookup_source` | `path` | Reads local state to find whether this machine already published that file, and returns the exact `relic_republish` call. Calls no server. |
| `relic_list` | optional `limit`, `include_expired`, `verify`, `refresh` | Every relic this machine published, newest first. The only tool that enumerates: lookup answers only from the file a relic came from. A name this machine never recorded is recovered by decrypting the relic's own envelope in one 64 KB range request, or comes back `null` with the reason. A relic the service will not serve is listed with which of removed, expired, exhausted, or unreachable it is. Each row carries the share URL, fragment included, so each row is a credential. Reaching the service spends one of a relic's finite opens; recovered names are cached, so a repeat listing spends none. |
| `relic_show` | `relic_id`, optional `include_content` | One relic in detail, including how many versions the service holds against how many this machine recorded, and with `include_content` the current decrypted content. Read it before republishing anything you did not just write: republish replaces what the link serves, so without the read-back the edit is blind. Content that is not valid UTF-8 is reported as size and type rather than mangled text. |
| `relic_republish` | `relic_id`, `path`, optional `filename`, `title`, `ttl_days` | Publishes a new version under the same key, so the share URL is unchanged. Replaces the plaintext title (defaults to the new filename; pass `""` to remove it). Works only on the machine holding that relic's key and publish token; a taken-down relic can never be revived. |
| `relic_read_comments` | `relic_id` | Returns the relic's comments oldest first, decrypted locally, with the author and a count of any that would not decrypt. Works only on the machine that published. |
| `relic_comment` | `relic_id`, `body`, optional `display_name` | Leaves a comment, encrypted on this machine, authorized by the publish token and attributed as `publisher`. Body caps at 4096 bytes of UTF-8. |
| `relic_describe_client` | none | Explains the encryption path. Reads nothing, sends nothing. |

## Environment

| Variable | Meaning |
|---|---|
| `RELIC_SERVICE_ORIGIN` | The Relic service to publish to. |
| `RELIC_ORIGIN` | Origin used to build the shareable URL. Defaults to the above. |
| `RELIC_CLIENT_NAME` | Reported to the service as the publishing client. |
| `RELIC_PUBLISH_STATE` | Where the publish state file lives. Defaults to `$XDG_CONFIG_HOME/relic-mcp/publish-state.json`, or `~/.config/relic-mcp/publish-state.json`. |
| `RELIC_METADATA_CACHE` | Where recovered filenames are cached. Defaults to `metadata-cache.json` beside the publish state. Holds no key and no token; deleting it costs one round of recovery. |
| `RELIC_MCP_HTTP` | `1` to serve Streamable HTTP instead of stdio. |
| `RELIC_MCP_PORT`, `RELIC_MCP_HOST` | HTTP bind. Defaults to `127.0.0.1:7333`. |
| `RELIC_MCP_ALLOWED_ORIGINS` | Comma-separated `Origin` allowlist for HTTP. |

## Protocol

MCP revision `2026-07-28`, the stateless one: no handshake, no session, no
`Mcp-Session-Id`. No protocol state is retained between calls; the one thing
that does outlive a call is the per-machine publish state file described
above. The handshake-based revisions (`2025-11-25` and earlier) are still
answered.

Requires Node 18 or newer.

MIT licensed. Source: https://github.com/TheBushidoCollective/relic
