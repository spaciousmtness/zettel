import { json, fail, cors } from "./lib/respond.js";
import { rateLimit, clientIp } from "./lib/ratelimit.js";
import { emailStart, emailCallback, phoneStart, phoneVerify, signOut }
  from "./routes/auth.js";
import { oidcStart, oidcCallback, providerStatus } from "./routes/oidc.js";
import { requestAccess } from "./routes/access.js";
import { me, startPairing, claimPairing, closeAccount } from "./routes/me.js";
import { pull, push, forgetTimeline } from "./routes/sync.js";

// The router. Flat on purpose: a table you can read top to bottom is a
// table an auditor can read top to bottom, and "which routes need a
// session" should never require tracing middleware to answer.
//
// Auth is per-handler rather than by prefix. A prefix rule is one typo away
// from exposing a route, and it hides the answer to the only question that
// matters about any given endpoint.

const ROUTES = [
  ["POST",   "/access",               requestAccess],

  ["POST",   "/auth/email/start",     emailStart],
  ["GET",    "/auth/email/callback",  emailCallback],
  ["POST",   "/auth/phone/start",     phoneStart],
  ["POST",   "/auth/phone/verify",    phoneVerify],
  ["POST",   "/auth/signout",         signOut],

  ["GET",    "/me",                   me],
  ["POST",   "/me/pair",              startPairing],
  ["DELETE", "/me",                   closeAccount],
  ["POST",   "/pair/claim",           claimPairing],

  ["GET",    "/sync",                 pull],
  ["POST",   "/sync",                 push],
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const headers = cors(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    // A floor under every route, before any handler and before any database
    // work. The per-route limits are tighter and more specific; this one
    // exists so that an unknown path cannot be hammered for free either.
    const flood = await rateLimit(env, `all:${clientIp(request)}`,
      { limit: 300, windowSec: 60 });
    if (!flood.ok) {
      return fail(429, "slow_down", "too many requests",
        { ...headers, "Retry-After": String(flood.retryAfter || 60) });
    }

    try {
      if (path === "/health") {
        // Deliberately says nothing about the database's contents or its
        // shape. A health check is a public endpoint and it is not a place
        // to publish the schema version to whoever asks.
        return json({ ok: true, providers: providerStatus(env) }, 200, headers);
      }

      // /auth/:provider/(start|callback) — matched before the flat table so
      // a provider name can never collide with a literal route above.
      const oidc = path.match(/^\/auth\/(google|apple)\/(start|callback)$/);
      if (oidc) {
        const [, provider, step] = oidc;
        if (step === "start" && request.method === "GET") {
          return await oidcStart(request, env, provider);
        }
        if (step === "callback" &&
            (request.method === "GET" || request.method === "POST")) {
          return await oidcCallback(request, env, provider);
        }
        return fail(405, "bad_method", "not that verb", headers);
      }

      const forget = path.match(/^\/sync\/timeline\/([a-f0-9]{64})$/);
      if (forget && request.method === "DELETE") {
        return withHeaders(await forgetTimeline(request, env, forget[1]), headers);
      }

      for (const [method, route, handler] of ROUTES) {
        if (route !== path) continue;
        if (method !== request.method) continue;
        return withHeaders(await handler(request, env, ctx), headers);
      }

      // A path that exists under another verb should say so, rather than
      // 404ing and sending someone hunting for a typo that isn't there.
      const verbs = ROUTES.filter(([, route]) => route === path)
        .map(([method]) => method);
      if (verbs.length) {
        return fail(405, "bad_method", `try ${verbs.join(" or ")}`,
          { ...headers, Allow: verbs.join(", ") });
      }
      return fail(404, "no_route", "nothing here", headers);
    } catch (error) {
      // The caller gets a reference, never a stack. A stack trace in a
      // response body is a map of the server's internals, and the thing the
      // caller actually needs is a string they can quote in an email.
      const ref = crypto.randomUUID().slice(0, 8);
      console.error(`[${ref}]`, error?.stack || error);
      return fail(500, "server_error",
        `something went wrong on our side — reference ${ref}`, headers);
    }
  },
};

function withHeaders(response, extra) {
  if (!Object.keys(extra).length) return response;
  const merged = new Headers(response.headers);
  for (const [k, v] of Object.entries(extra)) merged.set(k, v);
  return new Response(response.body, { status: response.status, headers: merged });
}
