/**
 * The service worker.
 *
 * It exists to make the viewer installable and to survive a bad connection.
 * It caches the app shell and **nothing else**, and that boundary is a
 * privacy control rather than a performance choice.
 *
 * Three things are never cached, ever:
 *
 * 1. **Relic ciphertext.** The signed download URL is short-lived by design,
 *    and the whole point of the TTL and the per-object cap is that content
 *    stops being reachable. A cache entry would quietly outlive both, on the
 *    recipient's disk, past a takedown.
 * 2. **Mint responses.** They carry a signed URL and a remaining-cap count,
 *    both of which are correct only at the instant they were issued.
 * 3. **Anything under `/api/`.** Same reason, stated as a path rule so a new
 *    endpoint inherits it without anybody remembering to.
 *
 * Previously, this file used a hand-maintained constant ('relic-shell-v1')
 * with a comment to bump on every deploy. Because nothing bumped it, deploys
 * never changed the sw.js bundle, install never re-ran, and returning visitors
 * remained pinned to whichever shell version they first cached.
 *
 * The cache name is now derived at build time from a content hash of the
 * emitted shell assets (viewer.js, styles.css, manifest.webmanifest). When any
 * shell asset changes, the build injects a new build hash, altering SHELL_CACHE
 * and producing byte-different sw.js output. The browser sees the changed
 * sw.js on navigation or update check, runs install to fetch the new asset set
 * into the new cache generation, calls skipWaiting, and on activate purges
 * every older generation while claiming clients.
 *
 * This preserves generation atomicity wholesale: a reader never runs a new
 * viewer.js against an old styles.css. Per-request background revalidation
 * (stale-while-revalidate) in the fetch handler is deliberately omitted
 * because updating individual assets piecemeal would break this atomicity,
 * risking mismatched scripts and stylesheets if one fetch succeeds while
 * another fails. All shell updates proceed strictly through the service worker
 * install and activate lifecycle.
 */

/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;
declare const __BUILD_HASH__: string | undefined;
declare const __SHELL_CACHE__: string | undefined;

/**
 * Lazy chunks (such as the PDF renderer and worker) are deliberately omitted
 * from SHELL_ASSETS.
 *
 * Adding them here would force every visitor to download ~1.6MB of PDF code
 * on first visit during service worker install, defeating the lazy chunk
 * split for readers of markdown, code, image, and media relics. A recipient
 * opening a PDF relic fetches the renderer on demand.
 */
export const SHELL_ASSETS = [
  '/assets/viewer.js',
  '/assets/styles.css',
  '/manifest.webmanifest',
] as const;

/**
 * Computes the cache generation name from a build identity hash.
 * If no build hash is provided (e.g. in development or unit tests),
 * returns a development fallback name.
 */
export function shellCacheName(buildId?: string): string {
  if (buildId && buildId.length > 0) {
    return `relic-shell-${buildId}`;
  }
  return 'relic-shell-dev';
}

/**
 * The cache generation name for the active build.
 * Injected at build time by build.ts from a content hash of the shell assets.
 */
export const SHELL_CACHE =
  typeof __SHELL_CACHE__ !== 'undefined'
    ? __SHELL_CACHE__
    : typeof __BUILD_HASH__ !== 'undefined'
      ? shellCacheName(__BUILD_HASH__)
      : shellCacheName();

export function isCacheable(url: URL, sameOrigin: boolean): boolean {
  if (!sameOrigin) return false; // storage lives elsewhere; never cache it
  if (url.pathname.startsWith('/api/')) return false;
  return (SHELL_ASSETS as readonly string[]).includes(url.pathname);
}

export interface MinimalCache {
  addAll(requests: string[]): Promise<void>;
}

export interface MinimalCacheStorage {
  open(cacheName: string): Promise<MinimalCache>;
  keys(): Promise<string[]>;
  delete(cacheName: string): Promise<boolean>;
}

/**
 * Installs the new generation of shell assets into cache storage.
 *
 * Wholesale atomicity: cache.addAll fetches all assets in SHELL_ASSETS. If any
 * fail, the entire install rejects and the previous worker remains active.
 */
export async function installShell(
  cacheStorage: MinimalCacheStorage,
  cacheName: string,
  assets: readonly string[] = SHELL_ASSETS,
  skipWaiting?: () => Promise<void> | void
): Promise<void> {
  const cache = await cacheStorage.open(cacheName);
  await cache.addAll(assets as string[]);
  await skipWaiting?.();
}

/**
 * Activates the new generation and purges all older cache generations.
 *
 * Returns the list of deleted cache names.
 */
export async function activateShell(
  cacheStorage: MinimalCacheStorage,
  currentCache: string,
  claim?: () => Promise<void> | void
): Promise<string[]> {
  const names = await cacheStorage.keys();
  const toDelete = names.filter((name) => name !== currentCache);
  await Promise.all(toDelete.map((name) => cacheStorage.delete(name)));
  await claim?.();
  return toDelete;
}

// Guarded so the cacheability rule and lifecycle helpers can be imported and
// tested directly. A service worker global is the one place a stray top-level
// listener cannot be undone.
const inServiceWorker =
  typeof self !== 'undefined' &&
  'skipWaiting' in self &&
  typeof self.skipWaiting === 'function';

if (inServiceWorker) {
  self.addEventListener('install', (event) => {
    event.waitUntil(
      installShell(caches, SHELL_CACHE, SHELL_ASSETS, () => self.skipWaiting())
    );
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      activateShell(caches, SHELL_CACHE, () => self.clients.claim())
    );
  });

  self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    const sameOrigin = url.origin === self.location.origin;

    if (!isCacheable(url, sameOrigin)) {
      // Explicitly not handled, so it goes straight to the network and never
      // touches a cache.
      return;
    }

    event.respondWith(
      caches.match(request).then((hit) => hit ?? fetch(request))
    );
  });
}
