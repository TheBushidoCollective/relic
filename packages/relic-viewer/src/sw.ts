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
 * The shell is cached with a versioned name, so a deploy invalidates it
 * wholesale rather than leaving a half-old viewer decrypting with a half-new
 * format reader.
 */

/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

/** Bump on every deploy. The old cache is deleted on activate. */
const SHELL_CACHE = 'relic-shell-v1';

const SHELL_ASSETS = [
  '/assets/viewer.js',
  '/assets/styles.css',
  '/manifest.webmanifest',
];

/**
 * Lazy chunks (such as the PDF renderer and worker) are deliberately omitted
 * from SHELL_ASSETS.
 *
 * Adding them here would force every visitor to download ~1.6MB of PDF code
 * on first visit during service worker install, defeating the lazy chunk
 * split for readers of markdown, code, image, and media relics. A recipient
 * opening a PDF relic fetches the renderer on demand.
 */

export function isCacheable(url: URL, sameOrigin: boolean): boolean {
  if (!sameOrigin) return false; // storage lives elsewhere; never cache it
  if (url.pathname.startsWith('/api/')) return false;
  return SHELL_ASSETS.includes(url.pathname);
}

// Guarded so the cacheability rule can be imported and tested directly. A
// service worker global is the one place a stray top-level listener cannot be
// undone.
const inServiceWorker =
  typeof self !== 'undefined' &&
  typeof (self as unknown as { skipWaiting?: unknown }).skipWaiting ===
    'function';

if (inServiceWorker) {
  self.addEventListener('install', (event) => {
    event.waitUntil(
      caches
        .open(SHELL_CACHE)
        .then((cache) => cache.addAll(SHELL_ASSETS))
        .then(() => self.skipWaiting())
    );
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      caches
        .keys()
        .then((names) =>
          Promise.all(
            names
              .filter((name) => name !== SHELL_CACHE)
              .map((name) => caches.delete(name))
          )
        )
        .then(() => self.clients.claim())
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
