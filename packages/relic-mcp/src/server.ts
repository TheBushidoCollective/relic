/**
 * The MCP server: a local binary, never a remote surface.
 *
 * It holds the key and encrypts in process. It returns no script. That is
 * locked in `docs/frame.md` and it is the single most load-bearing structural
 * decision in the publish path.
 *
 * **Why this cannot be a hosted MCP server**, stated once because it is the
 * question everybody asks: a remote server would have to receive the file to
 * encrypt it, which destroys the product. Zero-knowledge is not a feature
 * layered on top; it is a consequence of the encryption happening on the
 * machine that already has the plaintext. The transport can be stdio or HTTP,
 * but the process runs next to the file either way.
 *
 * Protocol revision `2026-07-28`, which is stateless: no handshake, no
 * session, no `Mcp-Session-Id`. Nothing is retained between calls, so the
 * server can be restarted or run one-shot without a client noticing. The
 * legacy `initialize` handshake is answered too, which the spec calls a
 * dual-era server, because a client that only speaks the newest revision is
 * unusable in most of the agents this product exists to serve.
 */

import { type CommentRecord, postComment, readComments } from './comments.ts';
import {
  type ListResult,
  listRelics,
  MAX_INLINE_CONTENT_BYTES,
  type RelicRow,
  type ShowResult,
  showRelic,
} from './inventory.ts';
import {
  ERROR_CODES,
  errorResponse,
  isSupportedVersion,
  type JsonRpcRequest,
  type JsonRpcResponse,
  LEGACY_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  requestedProtocolVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
  unsupportedVersionError,
} from './protocol.ts';
import {
  lookupPublishedSource,
  type PublishDeps,
  PublishError,
  publish,
  republishToolCall,
  ServerRefusal,
} from './publish.ts';
import { republish } from './republish.ts';

export type { JsonRpcRequest, JsonRpcResponse };
export {
  LEGACY_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
};

/**
 * `relic_publish`, prefixed with the product name.
 *
 * The MCP spec names the hazard and its own remedy: clients aggregating tools
 * from multiple servers may hit collisions and should prefix tool names with a
 * server identifier. A bare `publish` collides with incumbent publishing
 * servers, and the consequence is a security outcome produced by a naming
 * decision: the model asks for `publish`, the client disambiguates to whichever
 * server it prefers, and the file lands somewhere with different encryption or
 * none.
 */
export const TOOL_NAME = 'relic_publish';

/**
 * The inspection tool.
 *
 * A local client is opaque to the agent driving it, and "trust the binary" is
 * a real hand-wave. This closes that gap without reopening the one the frame
 * locked: the agent can read exactly what the encryption path does, on
 * demand, without any of it being code that arrives ready to execute.
 *
 * Inspection decoupled from execution beats inspect-then-run, because the
 * reviewer is not under time pressure and the reviewed text cannot also be
 * the attack.
 */
export const DESCRIBE_TOOL_NAME = 'relic_describe_client';

/**
 * The republish tool: a new version of a relic this machine published.
 *
 * A separate tool rather than an argument on publish, because the two calls
 * hold different secrets and different failure modes. Publish mints an id
 * and a key; republish consumes ones recorded locally, and refusing when
 * they are absent is the machine boundary made visible. Folding it into
 * publish would turn "published from another machine" into a retry loop
 * that can never succeed.
 */
export const REPUBLISH_TOOL_NAME = 'relic_republish';

/**
 * Source lookup is a separate read-only tool.
 *
 * An agent needs the id before it chooses publish or republish, and a lookup
 * hidden inside either write tool would only be observable after choosing the
 * wrong one. This call reads local state and never contacts the service.
 */
export const LOOKUP_TOOL_NAME = 'relic_lookup_source';

/**
 * The inventory tools, and why enumeration had to be its own surface.
 *
 * `relic_lookup_source` answers "did I publish this file", which is only
 * askable by somebody holding the file. Every other question a publisher has
 * later starts from nothing: what have I published, what does that link hold
 * now, is it still alive. On the file that prompted these, the source index
 * named four of forty one relics, so thirty seven had a key and a publish
 * token on disk and no tool that could say their names.
 *
 * Two tools rather than one because they cost differently. The list walks
 * every relic and prefers the unmetered check; the show reaches into one
 * relic and decrypts it, which is what turns a blind republish into an edit.
 * Folding them together would make a listing pay a read's price per row.
 */
export const LIST_TOOL_NAME = 'relic_list';

export const SHOW_TOOL_NAME = 'relic_show';

/**
 * Said on both inventory tools, because a row is not a description of a
 * relic: it is a working key to it.
 */
const SHARE_URL_DISCLOSURE =
  'Every row carries the relic\u2019s share URL including its fragment, and ' +
  'the fragment is the decryption key, so each row is a credential that ' +
  'opens the file for anyone who reads it, this transcript included.';

/**
 * The cost of asking the service, stated on the tools that spend it.
 *
 * A publisher who does not know a listing spends opens cannot choose not to,
 * and the cap is not refillable.
 */
const OPEN_COST_DISCLOSURE =
  'Reaching the service for a relic spends one of its finite opens, which ' +
  'never come back. Names recovered by decrypting are cached locally, so a ' +
  'repeat listing spends none.';

/**
 * The comment tools, and why they are two rather than one.
 *
 * Reading is the half that makes comments worth having for an agent: a person
 * leaves a comment, the agent reads it back, and it acts on it. Writing is
 * the half that lets the agent answer. They are separated for the same reason
 * lookup is separate from republish: the read needs no credential and the
 * write spends the publish token, so folding them together would make an
 * agent that only wants to read present a write credential to find out.
 *
 * Both take a relic id, never the share URL. The fragment is the key.
 */
export const READ_COMMENTS_TOOL_NAME = 'relic_read_comments';

export const COMMENT_TOOL_NAME = 'relic_comment';

/**
 * The one sentence about comments an agent has to have before it reads any,
 * carried on both comment tools and in the handshake instructions the way the
 * version-history disclosure is.
 */
const COMMENT_MACHINE_BOUNDARY =
  'Only works for a relic this machine published: the comment key is derived ' +
  "from that relic's key, which lives in local publish state and nowhere the " +
  'service can reach.';

/**
 * The ceiling on a publisher-supplied lifetime, matching the grant
 * contract's `maxTtlDays`. Refusing here keeps a typo like 36500 from
 * encrypting the file and round-tripping a grant only to be turned down
 * after the work is done.
 */
const MAX_TTL_DAYS = 3650;

const VERSION_HISTORY_DISCLOSURE =
  "Anyone holding a relic's link can fetch every version it has ever held, " +
  'so republishing does not withdraw earlier content.';

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  title: 'Publish a relic',
  description:
    'Encrypt a file on this machine and publish it as a new relic, returning ' +
    'a shareable URL. Publishing an update this way costs a second URL that ' +
    'nobody holding the first one will ever see; use relic_republish instead ' +
    'so the existing URL keeps working. ' +
    VERSION_HISTORY_DISCLOSURE +
    ' The encryption key is generated locally and never sent to the service. ' +
    'Takes a filesystem path, never ' +
    'inline content.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Filesystem path to the file to publish.',
      },
      filename: {
        type: 'string',
        description:
          'Optional. Overrides the name written into the encrypted envelope ' +
          'header. Defaults to the basename of `path`.',
      },
      ttl_days: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_TTL_DAYS,
        description:
          'Optional. Gives the relic a lifetime in days. Omit it and the ' +
          'relic is kept until it is deleted. Shorter is better for ' +
          'sensitive content.',
      },
      force_new: {
        type: 'boolean',
        default: false,
        description:
          'Optional. Publish a deliberately separate relic even when this ' +
          'machine already published the same source. Defaults to false. Use ' +
          'only when you want two independent URLs for one file.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      relic_id: { type: 'string' },
      version: {
        type: 'integer',
        minimum: 1,
        description: 'Always 1 from this tool; republish counts upward.',
      },
      relic_expires_at: { type: ['string', 'null'] },
      renderer_class: { type: 'string' },
      filename: { type: 'string' },
      resolved_path: { type: 'string' },
      report_url: { type: 'string' },
      disclosure_url: { type: 'string' },
    },
    required: [
      'url',
      'relic_id',
      'version',
      'relic_expires_at',
      'renderer_class',
      'filename',
      'resolved_path',
      'report_url',
      'disclosure_url',
    ],
    additionalProperties: false,
  },
} as const;

export const REPUBLISH_TOOL_DEFINITION = {
  name: REPUBLISH_TOOL_NAME,
  title: 'Republish a relic',
  description:
    'Publish a new version of a relic this machine originally published, ' +
    'encrypting under the same key so the existing share URL keeps working. ' +
    VERSION_HISTORY_DISCLOSURE +
    " Only possible from the machine that holds the relic's key and publish " +
    'token; a relic that was taken down can never be revived.',
  inputSchema: {
    type: 'object',
    properties: {
      relic_id: {
        type: 'string',
        description: 'The 26-character relic id the original publish returned.',
      },
      path: {
        type: 'string',
        description:
          'Filesystem path to the file that becomes the new version.',
      },
      filename: {
        type: 'string',
        description:
          'Optional. Overrides the name written into the encrypted envelope ' +
          'header of the new version. Defaults to the basename of `path`.',
      },
      ttl_days: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_TTL_DAYS,
        description:
          'Optional. A lifetime in days, forwarded on the republish ' +
          "request. The service fixes a relic's lifetime at its first " +
          'publish, so treat this as reserved.',
      },
    },
    required: ['relic_id', 'path'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      relic_id: { type: 'string' },
      version: {
        type: 'integer',
        minimum: 2,
        description: 'The version just published.',
      },
      relic_expires_at: { type: ['string', 'null'] },
      renderer_class: { type: 'string' },
      filename: { type: 'string' },
      resolved_path: { type: 'string' },
      report_url: { type: 'string' },
      disclosure_url: { type: 'string' },
    },
    required: [
      'relic_id',
      'version',
      'relic_expires_at',
      'renderer_class',
      'filename',
      'resolved_path',
      'report_url',
      'disclosure_url',
    ],
    additionalProperties: false,
  },
} as const;

export const LOOKUP_TOOL_DEFINITION = {
  name: LOOKUP_TOOL_NAME,
  title: 'Look up a published source',
  description:
    'Look up whether this machine already published a file and return the ' +
    'relic id needed by relic_republish. Reads local publish state only and ' +
    'never calls the service.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Filesystem path to the source to look up.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      found: { type: 'boolean' },
      relic_id: { type: ['string', 'null'] },
      version: { type: ['integer', 'null'], minimum: 1 },
      resolved_path: { type: 'string' },
      source_identity: { type: 'string' },
      source_description: { type: 'string' },
      republish_call: {
        type: ['object', 'null'],
        properties: {
          name: { type: 'string', const: REPUBLISH_TOOL_NAME },
          arguments: {
            type: 'object',
            properties: {
              relic_id: { type: 'string' },
              path: { type: 'string' },
            },
            required: ['relic_id', 'path'],
            additionalProperties: false,
          },
        },
        required: ['name', 'arguments'],
        additionalProperties: false,
      },
    },
    required: [
      'found',
      'relic_id',
      'version',
      'resolved_path',
      'source_identity',
      'source_description',
      'republish_call',
    ],
    additionalProperties: false,
  },
} as const;

export const LIST_TOOL_DEFINITION = {
  name: LIST_TOOL_NAME,
  title: 'List the relics this machine published',
  description:
    'List every relic this machine has published, newest first, with its ' +
    'name, version, lifetime, status, and share URL. This is the only tool ' +
    'that enumerates: relic_lookup_source finds a relic from the file it ' +
    'came from, so a relic whose source path is unrecorded or has moved is ' +
    'invisible to it while still being fully republishable from here. ' +
    'A relic\u2019s name lives inside its encrypted envelope, so a name this ' +
    'machine never wrote down is recovered by decrypting the relic rather ' +
    'than guessed; a name that could not be recovered comes back null with ' +
    'the reason, never invented. Nothing is dropped: a relic the service ' +
    'cannot serve is listed with what went wrong, because a short list would ' +
    'read as having published less. ' +
    SHARE_URL_DISCLOSURE +
    ' ' +
    OPEN_COST_DISCLOSURE,
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        minimum: 1,
        description:
          'Optional. Return at most this many of the newest relics. The ' +
          'total held locally is reported either way.',
      },
      include_expired: {
        type: 'boolean',
        default: true,
        description:
          'Optional, defaults to true. Set false to leave out relics the ' +
          'service reports expired. How many were left out is still ' +
          'reported, so they are never silently absent.',
      },
      verify: {
        type: 'boolean',
        default: false,
        description:
          'Optional. Ask the service about every relic rather than only the ' +
          'ones needing a name recovered. Authoritative, and it spends one ' +
          'open per relic.',
      },
      refresh: {
        type: 'boolean',
        default: false,
        description:
          'Optional. Re-read every name from the relics themselves, ignoring ' +
          'the local cache. Spends one open per relic.',
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      count: { type: 'integer', minimum: 0 },
      total: {
        type: 'integer',
        minimum: 0,
        description: 'Relics in local state, before any limit or filter.',
      },
      truncated: { type: 'boolean' },
      excluded_expired: { type: 'integer', minimum: 0 },
      unreadable_entries: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Relic ids whose stored entry could not be read. Reported rather ' +
          'than skipped: each one is a relic this machine may no longer be ' +
          'able to republish.',
      },
      findable_by_source: {
        type: 'integer',
        minimum: 0,
        description:
          'How many of `total` relic_lookup_source can find. The gap is what ' +
          'this tool exists to close.',
      },
      recovered_filenames: { type: 'integer', minimum: 0 },
      opens_spent: {
        type: 'integer',
        minimum: 0,
        description:
          'Opens this call consumed against per-relic download caps. They do ' +
          'not come back.',
      },
      order: { type: 'string' },
      relics: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            relic_id: { type: 'string' },
            version: {
              type: 'integer',
              minimum: 1,
              description: 'Versions this machine has published.',
            },
            filename: { type: ['string', 'null'] },
            filename_basis: {
              type: ['string', 'null'],
              enum: ['recorded', 'envelope', 'cache', null],
              description:
                'Where the name came from. `envelope` means it was recovered ' +
                'by decrypting the relic itself.',
            },
            filename_unrecovered_reason: { type: ['string', 'null'] },
            mimetype: { type: ['string', 'null'] },
            published_at: { type: ['string', 'null'] },
            expires_at: { type: ['string', 'null'] },
            expires_at_known: {
              type: 'boolean',
              description:
                'False means no lifetime was recorded or learned, so a null ' +
                'expires_at is unknown rather than "never expires".',
            },
            source: { type: ['string', 'null'] },
            source_indexed: {
              type: 'boolean',
              description: 'Whether relic_lookup_source can find this relic.',
            },
            share_url: { type: 'string' },
            status: { type: 'string' },
            status_basis: {
              type: 'string',
              enum: ['mint', 'record', 'local'],
              description:
                'Which check produced the status. `record` is the unmetered ' +
                'one: it proves the service still knows the relic, not that ' +
                'its bytes still serve.',
            },
            status_detail: { type: 'string' },
          },
          required: [
            'relic_id',
            'version',
            'filename',
            'filename_basis',
            'filename_unrecovered_reason',
            'mimetype',
            'published_at',
            'expires_at',
            'expires_at_known',
            'source',
            'source_indexed',
            'share_url',
            'status',
            'status_basis',
            'status_detail',
          ],
          additionalProperties: false,
        },
      },
    },
    required: [
      'count',
      'total',
      'truncated',
      'excluded_expired',
      'unreadable_entries',
      'findable_by_source',
      'recovered_filenames',
      'opens_spent',
      'order',
      'relics',
    ],
    additionalProperties: false,
  },
} as const;

export const SHOW_TOOL_DEFINITION = {
  name: SHOW_TOOL_NAME,
  title: 'Show one relic, including what it holds now',
  description:
    'Show one relic this machine published: its name, how many versions the ' +
    'service holds, whether it still serves, and with include_content the ' +
    'current decrypted content. Read the content before calling ' +
    'relic_republish on a relic you did not just write: republish replaces ' +
    'what the link serves outright, and without reading it first the edit is ' +
    'blind. ' +
    VERSION_HISTORY_DISCLOSURE +
    ' Takes the relic id from relic_list, never the share URL. ' +
    SHARE_URL_DISCLOSURE +
    ' Spends one of the relic\u2019s opens.',
  inputSchema: {
    type: 'object',
    properties: {
      relic_id: {
        type: 'string',
        description: 'The 26-character relic id, as relic_list reports it.',
      },
      include_content: {
        type: 'boolean',
        default: false,
        description:
          'Optional. Fetch and decrypt the current version and return it as ' +
          'text. Content that is not valid UTF-8 comes back as its size and ' +
          'type instead, never as mangled text, and content over ' +
          `${MAX_INLINE_CONTENT_BYTES} bytes comes back as its size with no ` +
          'body, because a truncated one would read as the whole file and ' +
          'get republished as one.',
      },
    },
    required: ['relic_id'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      relic_id: { type: 'string' },
      version: {
        type: 'integer',
        minimum: 1,
        description: 'Versions this machine has published.',
      },
      versions: {
        type: ['integer', 'null'],
        minimum: 1,
        description:
          'Versions the service holds. Null when it could not be asked. A ' +
          'number above `version` means a republish reached the service and ' +
          'never made it into local state.',
      },
      filename: { type: ['string', 'null'] },
      filename_basis: {
        type: ['string', 'null'],
        enum: ['recorded', 'envelope', 'cache', null],
      },
      filename_unrecovered_reason: { type: ['string', 'null'] },
      mimetype: { type: ['string', 'null'] },
      renderer_class: { type: ['string', 'null'] },
      content_bytes: { type: ['integer', 'null'], minimum: 0 },
      content: { type: ['string', 'null'] },
      content_omitted_reason: { type: ['string', 'null'] },
      published_at: { type: ['string', 'null'] },
      expires_at: { type: ['string', 'null'] },
      expires_at_known: { type: 'boolean' },
      source: { type: ['string', 'null'] },
      source_indexed: { type: 'boolean' },
      share_url: { type: 'string' },
      status: { type: 'string' },
      status_basis: { type: 'string', enum: ['mint', 'record', 'local'] },
      status_detail: { type: 'string' },
      republish_call: {
        type: ['object', 'null'],
        description:
          'The call that replaces this content, when a source path was ' +
          'recorded. Null otherwise: any path would be a guess, and ' +
          'relic_republish takes the file to publish, not the old one.',
        properties: {
          name: { type: 'string', const: REPUBLISH_TOOL_NAME },
          arguments: {
            type: 'object',
            properties: {
              relic_id: { type: 'string' },
              path: { type: 'string' },
            },
            required: ['relic_id', 'path'],
            additionalProperties: false,
          },
        },
        required: ['name', 'arguments'],
        additionalProperties: false,
      },
    },
    required: [
      'relic_id',
      'version',
      'versions',
      'filename',
      'filename_basis',
      'filename_unrecovered_reason',
      'mimetype',
      'renderer_class',
      'content_bytes',
      'content',
      'content_omitted_reason',
      'published_at',
      'expires_at',
      'expires_at_known',
      'source',
      'source_indexed',
      'share_url',
      'status',
      'status_basis',
      'status_detail',
      'republish_call',
    ],
    additionalProperties: false,
  },
} as const;

export const READ_COMMENTS_TOOL_DEFINITION = {
  name: READ_COMMENTS_TOOL_NAME,
  title: "Read a relic's comments",
  description:
    'Read the comments people have left on a relic, oldest first, decrypted ' +
    'on this machine. Use it before changing content somebody was asked to ' +
    'review, and after sharing a link, because a comment is the only way a ' +
    'reader can answer back. ' +
    COMMENT_MACHINE_BOUNDARY +
    ' Takes the relic id, never the share URL: the URL carries the key in ' +
    'its fragment. A comment that will not decrypt is returned marked ' +
    'unreadable rather than dropped, so a shortened list never reads as ' +
    'agreement.',
  inputSchema: {
    type: 'object',
    properties: {
      relic_id: {
        type: 'string',
        description: 'The 26-character relic id the original publish returned.',
      },
    },
    required: ['relic_id'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      relic_id: { type: 'string' },
      count: { type: 'integer', minimum: 0 },
      unreadable_count: {
        type: 'integer',
        minimum: 0,
        description:
          'How many of `count` did not decrypt. Above zero means part of the ' +
          'conversation is unread, not absent.',
      },
      comments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            comment_id: { type: 'string' },
            author: {
              type: 'string',
              description:
                'The commenter\u2019s verified email address, or "publisher" ' +
                'for a comment written with a publish token.',
            },
            created_at: { type: 'string' },
            display_name: { type: ['string', 'null'] },
            body: { type: ['string', 'null'] },
            anchor: {
              type: ['object', 'null'],
              description:
                'What the comment marks, or null for a freeform one. ' +
                '`{kind:"text", quote}` is a passage the reader selected, so ' +
                'the quote names the line to act on. `{kind:"pin", x, y}` is ' +
                'a point on the rendered page in unit coordinates.',
              properties: {
                kind: { type: 'string', enum: ['text', 'pin'] },
                quote: { type: 'string' },
                x: { type: 'number' },
                y: { type: 'number' },
              },
            },
            readable: { type: 'boolean' },
            unreadable_reason: { type: ['string', 'null'] },
          },
          required: [
            'comment_id',
            'author',
            'created_at',
            'display_name',
            'body',
            'anchor',
            'readable',
            'unreadable_reason',
          ],
          additionalProperties: false,
        },
      },
    },
    required: ['relic_id', 'count', 'unreadable_count', 'comments'],
    additionalProperties: false,
  },
} as const;

export const COMMENT_TOOL_DEFINITION = {
  name: COMMENT_TOOL_NAME,
  title: 'Comment on a relic',
  description:
    'Leave a comment on a relic this machine published, encrypted here so ' +
    'the service stores ciphertext it cannot read. Everyone holding the ' +
    'link sees it. Attribution is the publish token, so the comment is ' +
    'attributed to "publisher" rather than to an email address: an agent has ' +
    'no mailbox and cannot verify one. That is attribution and not ' +
    'authorization. ' +
    COMMENT_MACHINE_BOUNDARY +
    ' Takes the relic id, never the share URL.',
  inputSchema: {
    type: 'object',
    properties: {
      relic_id: {
        type: 'string',
        description: 'The 26-character relic id the original publish returned.',
      },
      body: {
        type: 'string',
        description:
          'The comment text, up to 4096 bytes of UTF-8. It is encrypted ' +
          'before it leaves this machine.',
      },
      display_name: {
        type: 'string',
        description:
          'Optional. A name shown beside the comment, up to 64 bytes of ' +
          'UTF-8. It aliases the attribution for presentation and never ' +
          'replaces it.',
      },
    },
    required: ['relic_id', 'body'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      relic_id: { type: 'string' },
      comment_id: { type: 'string' },
      author: { type: 'string' },
      created_at: { type: 'string' },
    },
    required: ['relic_id', 'comment_id', 'author', 'created_at'],
    additionalProperties: false,
  },
} as const;

export const DESCRIBE_TOOL_DEFINITION = {
  name: DESCRIBE_TOOL_NAME,
  title: 'Describe the Relic client',
  description:
    'Return exactly what this client does with your file: the encryption ' +
    'path, what leaves the machine, and what the service can see. Reads ' +
    'nothing and sends nothing.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
} as const;

/**
 * The build stamps the published version in, from package.json, which the
 * release workflow rewrites before it builds. It used to be a literal, and it
 * went stale immediately: the tarball published as 0.2.0 introduced itself to
 * every client as 0.1.0.
 *
 * An unbuilt run says so rather than guessing at a release number, because a
 * dev process claiming a version somebody could look up is worse than one
 * admitting it has none.
 */
export const SERVER_VERSION = process.env.RELIC_MCP_VERSION ?? '0.0.0-dev';

export const SERVER_INFO = {
  name: 'relic',
  title: 'Relic',
  version: SERVER_VERSION,
} as const;

export const CAPABILITIES = { tools: {} } as const;

/**
 * Server-level guidance, returned on the handshake so a client can put it in
 * the model's context before any tool is called.
 *
 * The plugin ships a skill with the same facts, but a skill only reaches
 * Claude Code, and only when somebody installs the plugin rather than wiring
 * this server directly. Every other client saw tool descriptions and nothing
 * else, which left six things an agent cannot read off a schema.
 *
 * Item five is one of the two reasons this exists at all rather than living
 * only in a tool result. The publish result arrives after the file is
 * written, which is too late for an agent that already linked a stylesheet
 * from a CDN. Item six is the other: an agent that never learns comments
 * exist never reads one. Both land before the work, which is the only moment
 * either can be acted on.
 *
 * It costs context on every session, so it stays short and it stays true.
 * Anything that needs a paragraph belongs in the skill or the disclosure.
 */
export const INSTRUCTIONS = `Relic encrypts a file on this machine and uploads \
only ciphertext. The key lives in the URL fragment, which browsers never send \
to a server.

Six things that change how you should act:

1. The link is the credential. Anyone holding it, fragment included, can read \
the file. Do not paste it into a tracker, a log, or a public channel.
2. Publishing puts the key in this transcript. That is structural, and worth \
saying plainly when you hand the link over.
3. relic_list shows every relic published from here; relic_lookup_source \
finds one only from the file it came from. relic_show reads what a link holds \
now, so an update is an edit, not a guess; relic_republish keeps the URL \
where relic_publish costs a second URL. \
${VERSION_HISTORY_DISCLOSURE}
4. A relic can be republished only from the machine that published it, where \
its key and publish token live. Anywhere else it refuses, and no retry \
changes that.
5. HTML and JSX render in an isolated frame with no network access, so inline \
the styles, scripts, fonts, and images a page needs: a CDN reference renders \
as nothing. Decide before you write the file.
6. People can comment on a relic. Read them with relic_read_comments before \
you change reviewed content, and answer with relic_comment. Both take the \
relic id and attribute you as the publisher.`;

/**
 * Handle one JSON-RPC message.
 *
 * Returns undefined for notifications, which carry no id and take no
 * response. Nothing here reads or writes state that outlives the call.
 */
export async function handleMessage(
  message: JsonRpcRequest,
  deps: PublishDeps
): Promise<JsonRpcResponse | undefined> {
  if (message.id === undefined) return undefined; // notification
  const id = message.id ?? null;

  // `server/discover` and `initialize` are the two probes a client uses to
  // find out what this server speaks, so neither may be refused for declaring
  // a version the server does not have.
  const isProbe =
    message.method === 'server/discover' || message.method === 'initialize';

  const requested = requestedProtocolVersion(message);
  if (!isProbe && requested !== undefined && !isSupportedVersion(requested)) {
    return unsupportedVersionError(id, requested);
  }

  switch (message.method) {
    case 'server/discover':
      // Mandatory in this revision: supported versions, capabilities, and
      // identity in a single request, with no handshake to precede it.
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };

    case 'initialize': {
      // The legacy era. A modern client never sends this.
      const asked =
        (message.params?.['protocolVersion'] as string | undefined) ??
        PROTOCOL_VERSION;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: isSupportedVersion(asked) ? asked : PROTOCOL_VERSION,
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    }

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            TOOL_DEFINITION,
            LIST_TOOL_DEFINITION,
            SHOW_TOOL_DEFINITION,
            LOOKUP_TOOL_DEFINITION,
            REPUBLISH_TOOL_DEFINITION,
            READ_COMMENTS_TOOL_DEFINITION,
            COMMENT_TOOL_DEFINITION,
            DESCRIBE_TOOL_DEFINITION,
          ],
        },
      };

    case 'tools/call':
      return callTool(id, message.params ?? {}, deps);

    default:
      return errorResponse(
        id,
        ERROR_CODES.methodNotFound,
        `unknown method: ${message.method}`
      );
  }
}

/**
 * What a publisher of executable content needs to know, and nobody else can
 * use.
 *
 * `html` and `jsx` are the two classes that render author-written code, and
 * that code now runs in a frame served a policy with no remote source, so a
 * page built against a CDN comes out bare. The recipient cannot fix that; the
 * person publishing can, by inlining what the page needs.
 *
 * Every other class is inert markup or bytes, so the note would be noise.
 */
function isolationNote(rendererClass: string): string {
  if (rendererClass !== 'html' && rendererClass !== 'jsx') return '';
  return (
    'It renders in an isolated frame with no network access, so external ' +
    'images, fonts, scripts, and fetches will not load. Inline whatever the ' +
    'page needs.\n'
  );
}

async function callTool(
  id: string | number | null,
  params: Record<string, unknown>,
  deps: PublishDeps
): Promise<JsonRpcResponse> {
  if (params['name'] === DESCRIBE_TOOL_NAME) {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: describeClient(deps) }],
        structuredContent: {
          encryption: 'AES-128-GCM, RFC 8188 aes128gcm framing',
          key_origin: 'crypto.getRandomValues on this machine',
          key_transmitted_to_service: false,
          plaintext_transmitted_to_service: false,
          ciphertext_destination: 'object storage, via a signed URL',
          local_publish_state:
            'relic id, source identity, key, and publish token per relic, ' +
            'written 0600 under the user config directory; key and token ' +
            'are never printed or sent',
          comment_encryption:
            'AES-128-GCM under a key derived from the relic key with a ' +
            'distinct HKDF label, so comment bodies reach the service as ' +
            'ciphertext and the URL fragment is unchanged',
          comment_attribution:
            'the publish token, reported by the service as "publisher"; the ' +
            'operator learns which identity commented on which relic and when',
          service_origin: deps.serviceOrigin,
        },
        isError: false,
      },
    };
  }

  if (params['name'] === LOOKUP_TOOL_NAME) {
    return callLookup(id, params, deps);
  }

  if (params['name'] === LIST_TOOL_NAME) {
    return callList(id, params, deps);
  }

  if (params['name'] === SHOW_TOOL_NAME) {
    return callShow(id, params, deps);
  }

  if (params['name'] === REPUBLISH_TOOL_NAME) {
    return callRepublish(id, params, deps);
  }

  if (params['name'] === READ_COMMENTS_TOOL_NAME) {
    return callReadComments(id, params, deps);
  }

  if (params['name'] === COMMENT_TOOL_NAME) {
    return callComment(id, params, deps);
  }

  if (params['name'] !== TOOL_NAME) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      `unknown tool: ${String(params['name'])}`
    );
  }

  const args = (params['arguments'] ?? {}) as Record<string, unknown>;
  const path = args['path'];
  if (typeof path !== 'string' || path.length === 0) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`path` is required and must be a string'
    );
  }

  const filename =
    typeof args['filename'] === 'string' ? args['filename'] : undefined;

  const ttlDays = parseTtlDays(args['ttl_days']);
  if (!ttlDays.ok) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      `\`ttl_days\` must be an integer between 1 and ${MAX_TTL_DAYS}, or ` +
        'omitted to keep the relic until it is deleted'
    );
  }

  const forceNew = args['force_new'];
  if (forceNew !== undefined && typeof forceNew !== 'boolean') {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`force_new` must be a boolean or omitted'
    );
  }

  try {
    const result = await publish(
      {
        path,
        filename,
        ttl_days: ttlDays.days,
        force_new: forceNew === true,
      },
      deps
    );
    return {
      jsonrpc: '2.0',
      id,
      result: {
        // The full URL including the fragment, because relaying a usable link
        // is the product. The consequence is disclosed rather than hidden:
        // the key enters the model's context and the session transcript on
        // every publish, and the disclosure statement says so.
        content: [
          {
            type: 'text',
            text:
              `Published ${result.filename} as version 1 of a new relic.\n\n` +
              `${result.url}\n\n` +
              // No lifetime is the default, so the agent relaying this needs
              // a sentence that says so, not a date-shaped hole.
              (result.relic_expires_at === null
                ? 'It does not expire; it is kept until it is deleted. '
                : `Expires ${result.relic_expires_at}. `) +
              'Anyone with this link, ' +
              'including its fragment, can read the file. The key is in the ' +
              'fragment and it is now in this transcript. This machine can ' +
              'republish it later; the link will not change.\n' +
              // The publisher is the only party who can act on this, and the
              // publish call is the only moment they are looking. The relic
              // page used to carry it to the recipient, who cannot do
              // anything about a font that will not load.
              isolationNote(result.renderer_class) +
              `What Relic knows: ${result.disclosure_url}`,
          },
          { type: 'text', text: VERSION_HISTORY_DISCLOSURE },
        ],
        structuredContent: result,
        isError: false,
      },
    };
  } catch (error) {
    return { jsonrpc: '2.0', id, result: toolError(error) };
  }
}

async function callLookup(
  id: string | number | null,
  params: Record<string, unknown>,
  deps: PublishDeps
): Promise<JsonRpcResponse> {
  const args = (params['arguments'] ?? {}) as Record<string, unknown>;
  const path = args['path'];
  if (typeof path !== 'string' || path.length === 0) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`path` is required and must be a string'
    );
  }

  try {
    const lookup = await lookupPublishedSource(path, deps);
    const match = lookup.match;
    const republishCall =
      match === undefined
        ? null
        : republishToolCall(match.relic_id, lookup.resolved_path);
    const structuredContent = {
      found: match !== undefined,
      relic_id: match?.relic_id ?? null,
      version: match?.version ?? null,
      resolved_path: lookup.resolved_path,
      source_identity: lookup.source.identity,
      source_description: lookup.source.description,
      republish_call: republishCall,
    };
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text:
              match === undefined
                ? `No prior relic is recorded for ${lookup.source.description}.`
                : `Found ${lookup.source.description} as version ` +
                  `${match.version} of relic ${match.relic_id}.\n` +
                  `Call relic_republish(${JSON.stringify(
                    republishCall?.arguments
                  )}).`,
          },
        ],
        structuredContent,
        isError: false,
      },
    };
  } catch (error) {
    return { jsonrpc: '2.0', id, result: toolError(error) };
  }
}

async function callList(
  id: string | number | null,
  params: Record<string, unknown>,
  deps: PublishDeps
): Promise<JsonRpcResponse> {
  const args = (params['arguments'] ?? {}) as Record<string, unknown>;

  const limit = args['limit'];
  if (
    limit !== undefined &&
    (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1)
  ) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`limit` must be an integer of 1 or more, or omitted'
    );
  }

  for (const name of ['include_expired', 'verify', 'refresh'] as const) {
    if (args[name] !== undefined && typeof args[name] !== 'boolean') {
      return errorResponse(
        id,
        ERROR_CODES.invalidParams,
        `\`${name}\` must be a boolean or omitted`
      );
    }
  }

  try {
    const result = await listRelics(
      {
        limit: typeof limit === 'number' ? limit : undefined,
        include_expired: args['include_expired'] as boolean | undefined,
        verify: args['verify'] as boolean | undefined,
        refresh: args['refresh'] as boolean | undefined,
      },
      deps
    );
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: listTranscript(result) }],
        structuredContent: result,
        isError: false,
      },
    };
  } catch (error) {
    return { jsonrpc: '2.0', id, result: toolError(error) };
  }
}

async function callShow(
  id: string | number | null,
  params: Record<string, unknown>,
  deps: PublishDeps
): Promise<JsonRpcResponse> {
  const args = (params['arguments'] ?? {}) as Record<string, unknown>;
  const relicId = args['relic_id'];
  if (typeof relicId !== 'string' || relicId.length === 0) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`relic_id` is required and must be a string'
    );
  }

  const includeContent = args['include_content'];
  if (includeContent !== undefined && typeof includeContent !== 'boolean') {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`include_content` must be a boolean or omitted'
    );
  }

  try {
    const result = await showRelic(
      { relic_id: relicId, include_content: includeContent },
      deps
    );
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: showTranscript(result) }],
        structuredContent: result,
        isError: false,
      },
    };
  } catch (error) {
    return { jsonrpc: '2.0', id, result: toolError(error) };
  }
}

/**
 * One row as a person reads it.
 *
 * The status sentence is printed for anything other than a served relic,
 * because a row that reads like every other row while meaning "this link is
 * dead" is the failure the status exists to prevent. The share URL is last on
 * its own line: it is the credential, and burying it mid-sentence makes it
 * easy to paste somewhere it should not go.
 */
function relicLine(row: RelicRow): string {
  const name =
    row.filename ?? `[name unrecovered: ${row.filename_unrecovered_reason}]`;
  const versions = row.version === 1 ? 'v1' : `v${row.version}`;
  const when = row.published_at ?? 'date not recorded';
  const life =
    row.expires_at !== null
      ? `expires ${row.expires_at}`
      : row.expires_at_known
        ? 'no expiry'
        : 'lifetime not recorded';
  const state =
    row.status === 'reachable' ? '' : `\n  ${row.status}: ${row.status_detail}`;
  const finding = row.source_indexed
    ? ''
    : '\n  not findable by relic_lookup_source';
  return (
    `${name} (${row.relic_id}, ${versions}, ${when}, ${life})${state}${finding}` +
    `\n  ${row.share_url}`
  );
}

/**
 * The listing as a person reads it, with every number that cost something.
 *
 * The findable count leads because it is the whole point: a publisher who
 * believes lookup can find their relics does not know they need this tool
 * until they need it and it is not there.
 */
function listTranscript(result: ListResult): string {
  if (result.total === 0) {
    return (
      'This machine has published no relics, or its publish state was moved ' +
      'or deleted. A relic published from another machine cannot be listed ' +
      'here: its key never left that machine.'
    );
  }

  const header = [
    `${result.count} relic(s) of ${result.total} this machine published, ` +
      'newest first.',
    `${result.findable_by_source} of ${result.total} can be found by ` +
      'relic_lookup_source; the rest are reachable only through this list.',
  ];
  if (result.truncated) {
    header.push(`Limited to the newest ${result.count}.`);
  }
  if (result.excluded_expired > 0) {
    header.push(
      `${result.excluded_expired} expired relic(s) left out at your request, ` +
        'not missing.'
    );
  }
  if (result.unreadable_entries.length > 0) {
    header.push(
      `${result.unreadable_entries.length} stored entr(ies) could not be ` +
        'read and are not listed below, which means those relics may no ' +
        `longer be republishable from here: ${result.unreadable_entries.join(
          ', '
        )}.`
    );
  }
  if (result.recovered_filenames > 0) {
    header.push(
      `${result.recovered_filenames} name(s) were recovered by decrypting ` +
        'the relics themselves, because this machine never recorded them.'
    );
  }
  if (result.opens_spent > 0) {
    header.push(
      `This call spent ${result.opens_spent} open(s), one per relic asked ` +
        'about. They do not come back; a repeat listing spends none.'
    );
  }
  header.push(
    'Each line ends with a share URL whose fragment is the decryption key. ' +
      'Every one of them is now in this transcript and opens the file for ' +
      'anyone who reads it.'
  );

  return `${header.join(' ')}\n\n${result.relics
    .map((row) => relicLine(row))
    .join('\n\n')}`;
}

/**
 * One relic in full, ending with what to do next.
 *
 * The republish sentence is here rather than in the schema because it is the
 * reason the tool exists: reading the content back is what makes replacing it
 * an edit instead of a guess.
 */
function showTranscript(result: ShowResult): string {
  const lines = [relicLine(result)];

  if (result.versions !== null) {
    lines.push(
      result.versions === result.version
        ? `The service holds ${result.versions} version(s), which matches ` +
            'this machine\u2019s record.'
        : `The service holds ${result.versions} version(s) and this machine ` +
            `recorded ${result.version}. A republish reached the service ` +
            'without being recorded here, so the local count is behind.'
    );
  }

  if (result.mimetype !== null) {
    lines.push(
      `Declared type ${result.mimetype}` +
        (result.renderer_class === null
          ? ''
          : `, class ${result.renderer_class}`) +
        (result.content_bytes === null
          ? '.'
          : `, ${result.content_bytes} bytes.`)
    );
  }

  if (result.content !== null) {
    lines.push(
      'Current content follows. Republishing replaces what the link serves ' +
        'with whatever file you pass, so edit this and republish it rather ' +
        'than writing something new from memory.',
      '---',
      result.content,
      '---'
    );
  } else if (result.content_omitted_reason !== null) {
    lines.push(`No content returned: ${result.content_omitted_reason}`);
  }

  if (result.status === 'reachable') {
    lines.push(
      `To change it: write the new content to a file and call ` +
        `relic_republish with relic_id ${result.relic_id}. The share URL ` +
        'does not change, so everyone already holding it sees the new ' +
        `version. ${VERSION_HISTORY_DISCLOSURE}`
    );
  }

  return lines.join('\n\n');
}

async function callRepublish(
  id: string | number | null,
  params: Record<string, unknown>,
  deps: PublishDeps
): Promise<JsonRpcResponse> {
  const args = (params['arguments'] ?? {}) as Record<string, unknown>;
  const relicId = args['relic_id'];
  if (typeof relicId !== 'string' || relicId.length === 0) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`relic_id` is required and must be a string'
    );
  }

  const path = args['path'];
  if (typeof path !== 'string' || path.length === 0) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`path` is required and must be a string'
    );
  }

  const filename =
    typeof args['filename'] === 'string' ? args['filename'] : undefined;

  const ttlDays = parseTtlDays(args['ttl_days']);
  if (!ttlDays.ok) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      `\`ttl_days\` must be an integer between 1 and ${MAX_TTL_DAYS}, or ` +
        'omitted to leave the lifetime as the first publish set it'
    );
  }

  try {
    const result = await republish(
      { relic_id: relicId, path, filename, ttl_days: ttlDays.days },
      deps
    );
    return {
      jsonrpc: '2.0',
      id,
      result: {
        // No URL is printed here, on purpose. It has not changed, and
        // reprinting it would reprint the key for no new reader; the first
        // publish already made that disclosure once.
        content: [
          {
            type: 'text',
            text:
              `Republished ${result.filename} as version ${result.version} ` +
              `of relic ${result.relic_id}.\n\n` +
              'The share URL is unchanged: everyone holding the existing ' +
              'link, including its fragment, now sees this content. There ' +
              'is no new link to hand out.\n\n' +
              (result.relic_expires_at === null
                ? 'The relic does not expire; it is kept until it is deleted.'
                : `Expires ${result.relic_expires_at}.`) +
              '\n' +
              `What Relic knows: ${result.disclosure_url}`,
          },
          { type: 'text', text: VERSION_HISTORY_DISCLOSURE },
        ],
        structuredContent: result,
        isError: false,
      },
    };
  } catch (error) {
    return { jsonrpc: '2.0', id, result: toolError(error) };
  }
}

async function callReadComments(
  id: string | number | null,
  params: Record<string, unknown>,
  deps: PublishDeps
): Promise<JsonRpcResponse> {
  const args = (params['arguments'] ?? {}) as Record<string, unknown>;
  const relicId = args['relic_id'];
  if (typeof relicId !== 'string' || relicId.length === 0) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`relic_id` is required and must be a string'
    );
  }

  try {
    const result = await readComments(relicId, deps);
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: commentTranscript(result) }],
        structuredContent: result,
        isError: false,
      },
    };
  } catch (error) {
    return { jsonrpc: '2.0', id, result: toolError(error) };
  }
}

async function callComment(
  id: string | number | null,
  params: Record<string, unknown>,
  deps: PublishDeps
): Promise<JsonRpcResponse> {
  const args = (params['arguments'] ?? {}) as Record<string, unknown>;
  const relicId = args['relic_id'];
  if (typeof relicId !== 'string' || relicId.length === 0) {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`relic_id` is required and must be a string'
    );
  }

  const body = args['body'];
  if (typeof body !== 'string') {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`body` is required and must be a string'
    );
  }

  const displayName = args['display_name'];
  if (displayName !== undefined && typeof displayName !== 'string') {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      '`display_name` must be a string or omitted'
    );
  }

  try {
    const result = await postComment(
      { relic_id: relicId, body, display_name: displayName },
      deps
    );
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text:
              `Commented on relic ${result.relic_id} as ${result.author}.\n` +
              'Everyone holding the link sees it. The service stored ' +
              'ciphertext it cannot read, and it knows that this address ' +
              'commented on this relic at this time.',
          },
        ],
        structuredContent: result,
        isError: false,
      },
    };
  } catch (error) {
    return { jsonrpc: '2.0', id, result: toolError(error) };
  }
}

/**
 * The one line that says what a comment is attached to.
 *
 * A quote is printed verbatim, because the reader selected those exact words
 * and an agent's next move is usually to find them. A pin has no words, so it
 * gets its position rounded to whole percent: more precision than that is
 * noise a person cannot act on.
 */
function markLine(anchor: CommentRecord['anchor']): string {
  if (anchor === null) return '';
  if (anchor.kind === 'text') return `on "${anchor.quote}"\n`;
  const percent = (value: number): number => Math.round(value * 100);
  return `at ${percent(anchor.x)}% across, ${percent(anchor.y)}% down\n`;
}

/**
 * The comments as a person would read them, because a JSON array of rows is
 * not a conversation.
 *
 * Unreadable comments are printed in place, in order, with their reason. A
 * list that quietly closed over a gap would read as the whole conversation,
 * and an agent acting on "nobody objected" when somebody did is exactly the
 * failure the count exists to prevent.
 */
function commentTranscript(result: {
  readonly relic_id: string;
  readonly count: number;
  readonly unreadable_count: number;
  readonly comments: readonly CommentRecord[];
}): string {
  if (result.count === 0) {
    return `No comments on relic ${result.relic_id} yet.`;
  }

  const lines = result.comments.map((comment) => {
    const who =
      comment.display_name === null
        ? comment.author
        : `${comment.display_name} (${comment.author})`;
    if (!comment.readable) {
      return `${comment.created_at} ${who}:\n[unreadable: ${comment.unreadable_reason}]`;
    }
    // The mark goes above the body, because it is what the body is about. A
    // transcript that printed the remark and withheld the line it points at
    // would be the same defect this fixed, one layer up.
    const mark = markLine(comment.anchor);
    return `${comment.created_at} ${who}:\n${mark}${comment.body}`;
  });

  const header =
    result.unreadable_count === 0
      ? `${result.count} comment(s) on relic ${result.relic_id}, oldest first.`
      : `${result.count} comment(s) on relic ${result.relic_id}, oldest ` +
        `first. ${result.unreadable_count} did not decrypt and are shown as ` +
        'unreadable rather than dropped, so treat this conversation as ' +
        'partially unread.';

  return `${header}\n\n${lines.join('\n\n')}`;
}

/**
 * A lifetime is opt-in: absent or null means no change from the default. A
 * value that fails the contract is refused rather than dropped, because
 * silently dropping it does the opposite of what was asked: a relic meant
 * to die in days lives forever.
 */
function parseTtlDays(
  raw: unknown
): { ok: true; days: number | undefined } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, days: undefined };
  if (
    typeof raw !== 'number' ||
    !Number.isSafeInteger(raw) ||
    raw < 1 ||
    raw > MAX_TTL_DAYS
  ) {
    return { ok: false };
  }
  return { ok: true, days: raw };
}

/**
 * Refusals a publisher must understand on their own terms.
 *
 * The server's problem document carries the code; these sentences carry
 * what the publisher can still do, because "403" and "410" answer nothing
 * a human would ask. The first two must stay distinct: one means this machine
 * lost its standing, the other means nobody has any, ever again.
 */
const REFUSAL_GUIDANCE: Readonly<Record<string, string>> = {
  invalid_publish_token:
    'The publish token this machine holds for that relic was rejected. It ' +
    'is issued once, at first publish, and never changes, so a rejection ' +
    "means the local record no longer matches the service's. The relic can " +
    'still be read at its existing link, but it cannot be republished from ' +
    'here.',
  relic_removed:
    'That relic was taken down. A takedown is permanent: republishing ' +
    'cannot revive it, whatever token is presented. Publish the content as ' +
    'a new relic instead.',
  comment_rate_limited:
    'The service is rate limiting comments on that relic. The refusal ' +
    'carries retry_after_seconds; wait it out rather than retrying in a ' +
    'loop, which only extends the limit.',
};

/**
 * A failed publish is a tool error, not a protocol error.
 *
 * The distinction is the spec's: a protocol error means the call could not be
 * made, and a tool error means it was made and failed. Reporting a refused
 * publish as a protocol error would hide it from the model, which then cannot
 * tell the user what went wrong or act on it.
 */
function toolError(error: unknown): Record<string, unknown> {
  if (error instanceof PublishError) {
    return {
      content: [{ type: 'text', text: `${error.code}: ${error.message}` }],
      structuredContent: { code: error.code, ...error.details },
      isError: true,
    };
  }
  if (error instanceof ServerRefusal) {
    const guidance = REFUSAL_GUIDANCE[error.code];
    return {
      content: [
        {
          type: 'text',
          text:
            `${error.code}: ${error.message}` +
            (guidance === undefined ? '' : `\n${guidance}`),
        },
      ],
      structuredContent: { code: error.code, ...error.problem },
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: `the call failed: ${String(error)}` }],
    structuredContent: { code: 'unknown' },
    isError: true,
  };
}

/**
 * What this client does with a file, in the order it does it.
 *
 * Written out rather than pointing at a URL, because a description the agent
 * has to go fetch is a description nobody reads.
 */
export function describeClient(deps: PublishDeps): string {
  return `Relic publishing client, running locally on this machine.

What happens when you publish a file:

1. The file is read from disk by this process. It is never sent anywhere in
   plaintext.
2. A 128-bit key and a 26-character relic id are drawn independently from this
   machine's CSPRNG (crypto.getRandomValues). Neither derives from the other.
3. The file is encrypted here, in this process, with AES-128-GCM under RFC 8188
   aes128gcm framing: an HKDF-derived content key, counter-derived per-record
   nonces, and a per-record authentication tag.
4. Only ciphertext is uploaded, straight to object storage under a signed URL.
   It does not pass through ${deps.serviceOrigin}.
5. The service is told three things and nothing more: a coarse renderer class
   from a seven-value list, the name of this client, and the exact byte length
   of the ciphertext. Not your filename, not the mimetype, not the contents.
6. You get back a URL whose fragment carries the key. Fragments are never sent
   to a server by a browser.

What the service operator can see: that a relic exists, roughly how big it is,
what coarse class it was declared as, the publishing IP, and when it was
fetched. Never the contents, and never the key.

What this keeps on disk: for each relic you publish, its id, source identity,
key, and publish token, in a 0600 file under your user config directory. The
source index lets a fresh session find the id for relic_republish. The key and
token let that republish keep the same URL, and they are why republishing works
only on the machine that published. The token's SHA-256 is the only copy the
service ever holds, and neither secret is ever printed or logged. Deleting the
file changes nothing for existing links; it only ends this machine's ability
to update those relics.

What happens with comments: a comment body is encrypted here too, under a key
derived from that relic's key with a distinct HKDF label, so the service
stores comment ciphertext it cannot read and the URL fragment does not change.
Reading comments needs that key, and writing one is authorized by the publish
token, so both work only on the machine that published. A comment this client
writes is attributed to the publisher rather than an email address, because
an agent has no mailbox to verify. What the operator does learn is who
commented on which relic and when: for a person that is a verified email
address, and that association is a real cost the content's encryption does
not cover.

What this does NOT protect against: the key is returned to your agent in the
URL, so it enters the model's context and your session transcript. That is
structural, not a defect. Anyone who can read this conversation can open the
relic.

The code doing all of this is on disk in this package and can be read. Nothing
is fetched from the network and executed.`;
}

/** Read newline-delimited JSON-RPC from a stream and write responses back. */
export async function serveStdio(
  deps: PublishDeps,
  input: ReadableStream<Uint8Array>,
  write: (line: string) => void
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = input.getReader();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line.length === 0) continue;

      let message: JsonRpcRequest;
      try {
        message = JSON.parse(line) as JsonRpcRequest;
      } catch {
        write(
          JSON.stringify(
            errorResponse(null, ERROR_CODES.parseError, 'parse error')
          )
        );
        continue;
      }

      const response = await handleMessage(message, deps);
      if (response !== undefined) write(JSON.stringify(response));
    }
  }
}
