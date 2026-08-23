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

export {
  LEGACY_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
};
export type { JsonRpcRequest, JsonRpcResponse };

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
2. Publishing puts the key in this transcript. That is structural rather than \
a defect, and worth saying plainly when you hand the link over.
3. Check existing sources with relic_lookup_source. Use relic_republish when \
found; relic_publish otherwise costs a second URL. \
${VERSION_HISTORY_DISCLOSURE}
4. A relic can be republished only from the machine that published it, which \
is where its key and publish token are stored. Anywhere else it refuses, and \
no retry changes that.
5. Rendered HTML and JSX run in an isolated frame with no network access. \
Inline the styles, scripts, fonts, and images a page needs, because a CDN \
reference renders as nothing. Decide that before you write the file.
6. People can comment on a relic. Read them with relic_read_comments before \
you change reviewed content, and answer with relic_comment. Both take the \
relic id, work only on the machine that published, and attribute you as the \
publisher.`;

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
