# relic-mcp entry paths

## Source versioning

Run from the repository root:

```bash
bun packages/relic-mcp/test/source-versioning-path.ts
```

The command creates two worktrees of one temporary Git repository, publishes
from the first through `relic_publish`, then starts fresh MCP processes for
`relic_lookup_source` and the refused second `relic_publish` from the other
worktree. Success ends with:

```text
PUBLISHED relic_id=<id>
PUBLISH_DISCLOSURE Anyone holding a relic's link can fetch every version it has ever held, so republishing does not withdraw earlier content.
FRESH_LOOKUP relic_id=<same-id>
REFUSED code=source_already_published relic_id=<same-id>
SOURCE_VERSIONING_PATH_OK
```

## Comments an agent can read and write

Run from the repository root:

```bash
bun packages/relic-mcp/test/comment-path.ts
```

The command starts a loopback HTTP service standing in for Relic, publishes a
file, then starts fresh MCP processes for `relic_comment` and
`relic_read_comments`, so the read happens in a process holding nothing but the
state file on disk. It also asserts what the service stored is ciphertext, and
that a relic this machine never published and a share URL are both refused.
Success ends with:

```text
PUBLISHED relic_id=<id>
COMMENTED comment_id=c1 author=publisher
STORED_CIPHERTEXT <prefix>... (<n> chars, contains_plaintext=false)
READ_BACK count=1 author=publisher body="The second chart still uses last quarter numbers."
REFUSED_ELSEWHERE code=no_local_publish_state
REFUSED_URL_ARGUMENT code=no_local_publish_state
COMMENT_PATH_OK
```

## Finding and editing a relic whose source was never recorded

Run from the repository root:

```bash
bun packages/relic-mcp/test/inventory-path.ts
```

The command starts a loopback HTTP service standing in for Relic, publishes a
file, then strips the recorded entry back to the three fields a client older
than this one wrote and deletes the source file, which is the shape most of a
long-lived state file is in. Every step after that runs in a fresh MCP process
holding nothing but the state file: `relic_list` recovers the name by
decrypting the relic's first record, `relic_show` returns what the link
currently serves, `relic_republish` replaces it, and a second `relic_show`
proves the URL never changed. No URL is printed, because the fragment is the
key. Success ends with:

```text
SEEDED_LEGACY relic_id=<id> source_recorded=false
LISTED relic_id=<id> filename=quarterly-review.md basis=envelope findable_by_source=0
RECOVERED_BY_RANGE bytes=0-65556
READ_BACK versions=1 bytes=31
REPUBLISHED version=2
SAME_URL_NEW_CONTENT versions=2 url_unchanged=true
RELISTED opens_spent=0
NO_TOKEN_IN_OUTPUT true
INVENTORY_PATH_OK
```
