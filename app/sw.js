/* Zettel service worker — the shell opens without a network; the record
   never comes out of a cache.

   THE ONE RULE THAT MATTERS HERE. Nothing under /api/ is ever stored.
   Those answers are live state and the server marks them `no-store`; on
   2026-07-19 a heuristically cached live-edge cursor made a single new
   message read as "2 NEW MESSAGES". A cache-first (or even
   fall-back-to-cache) API is the same bug with a service worker's
   memory, so API requests are not intercepted at all — the browser
   fetches them, and offline they fail honestly instead of lying quietly.

   The pairing token is likewise never touched: a URL carrying ?key= is
   passed straight through, so the 303 that trades it for an HttpOnly
   cookie still happens and the secret never lands in Cache Storage.

   BUMP VERSION on any change to a precached file. The cache name carries
   it, activate() deletes every cache that isn't the current one, and
   skipWaiting/claim means one reload picks the new shell up. */

const VERSION = "2026-07-24b";
const SHELL_CACHE = `zettel-shell-${VERSION}`;

/* Relative to this script's own URL, so the same worker serves the app at
   an origin root, under a GitHub Pages project path, or behind a proxy.

   THIS LIST MUST COVER app.js's WHOLE STATIC IMPORT GRAPH. One missing
   module is a dead app offline, not a degraded one — ES modules fail the
   whole graph. zlayer.js was exactly that miss on the first pass; a smoke
   check now compares this list against index.html + the imports. */
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./timeline.js",
  "./waveform.js",
  "./chronology.js",
  "./shared.js",
  "./zlayer.js",
  "./styles.css",
  "./forme-tokens.css",
  "./pwa.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
];

/* localhost is her desk, not a judge's phone: a cache-first shell there
   would hand her a stale app.js after an edit (the server sends
   `no-cache` on app files for exactly that reason, and Cache Storage
   does not honour it). So: network-first at the desk, cache-first on a
   real HTTPS origin. Both still open with no network. */
const DEV = ["localhost", "127.0.0.1", "[::1]", "::1"]
  .includes(self.location.hostname);

const indexRequest = () =>
  new Request(new URL("index.html", self.registration.scope).href);

const storable = (res) =>
  !!res && res.ok && res.status === 200 && !res.redirected &&
  (res.type === "basic" || res.type === "default");

function keep(cache, key, res) {
  if (storable(res)) cache.put(key, res.clone()).catch(() => {});
  return res;
}

function revalidate(cache, key) {
  fetch(key, { cache: "no-cache" })
    .then((res) => keep(cache, key, res))
    .catch(() => {});
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    /* one missing asset must not fail the whole install */
    await Promise.allSettled(SHELL.map((path) => {
      const url = new URL(path, self.registration.scope).href;
      return fetch(new Request(url, { cache: "reload" }))
        .then((res) => keep(cache, url, res));
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("zettel-shell-") && name !== SHELL_CACHE) {
        await caches.delete(name);
      }
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return;
  /* never write a pairing token into a cache key, and never intercept the
     redirect that exists to get it out of the address bar */
  if (url.searchParams.has("key")) return;
  /* live state: not cached, not intercepted, not remembered */
  if (/(^|\/)api\//.test(url.pathname)) return;

  event.respondWith(req.mode === "navigate" ? shell(req) : asset(req));
});

/* every navigation resolves to the one shell entry, whatever query the
   URL carried (?calm=1, ?chat=…), so the app opens offline from one copy */
async function shell(req) {
  const cache = await caches.open(SHELL_CACHE);
  const key = indexRequest();
  if (!DEV) {
    const hit = await cache.match(key);
    if (hit) {
      revalidate(cache, key);
      return hit;
    }
  }
  try {
    return keep(cache, key, await fetch(req));
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}

async function asset(req) {
  const cache = await caches.open(SHELL_CACHE);
  if (!DEV) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) {
      revalidate(cache, req.url);
      return hit;
    }
  }
  try {
    return keep(cache, req.url, await fetch(req));
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}
