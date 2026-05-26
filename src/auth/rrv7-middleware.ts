// =====================================================================
// AUTH FLOW. Basically OAuth, but somewhat simpler.
// =====================================================================
//
// What this file does:
//
// A "Trellis App" is a small web app that other people deploy. We want some of
// those apps to require sign-in. The user signs in against the main CollegeVine
// site (where their account already lives), not against the deployed app, so
// the app does not have to store passwords or run its own auth UI. After
// sign-in, the app gets a credential it can use to call the Trellis App API on
// the signed-in user's behalf.
//
// This middleware orchestrates that whole dance. Every request that hits the
// deployed app flows through here first, via withAuth() in the SDK's Lambda
// adapter:
//
//   const guarded = withAuth(createRequestHandler(build))
//
// ---------------------------------------------------------------------
// The participants
// ---------------------------------------------------------------------
//
//   Browser:  the user's browser. App:      this deployed app. Has a server
//   side (where this middleware runs) and the pages it serves. Rails:    the
//   main CollegeVine Rails app at collegevine.com. Knows who the user is, what
//   school they belong to, and which Trellis Apps exist. We talk to two
//   endpoints on Rails: an "authorize" page (browser-facing) and a "token"
//   endpoint (server-to-server).
//
// ---------------------------------------------------------------------
// The flow, step by step
// ---------------------------------------------------------------------
//
// 1.  User opens https://<app-host>/dashboard.
//
// 2.  Middleware looks for a "session cookie" on the request. None, or it has
//     expired. Right here in the response to this same request, the middleware
//     generates two pieces of secret data:
//
//       state         a random value, stored in a short-lived cookie. We will
//                     see this value come back in the URL when Rails sends the
//                     user back; if the cookie value and the URL value do not
//                     match, we know the round-trip was tampered with and
//                     reject it. This blocks an attacker who tricks the victim
//                     into starting a flow under the attacker's control.
//
//       codeVerifier  a random secret, also stored in the same short-lived
//                     cookie. We hash it with SHA-256 to produce a
//                     `codeChallenge` that we send up to Rails. Later, Rails
//                     will hand us a one-time code, and we will hand back the
//                     verifier; Rails re-hashes it and checks that the result
//                     matches the challenge it stored. This proves the entity
//                     redeeming the code is the same one that started the flow,
//                     even if the code itself leaks (e.g. via referer headers
//                     or browser history).
//
//     The original path (/dashboard) is also stashed in the same short-lived
//     cookie so we can send the user back there at the end. The middleware then
//     302s the browser to the Rails authorize page, passing `app_id`, `state`,
//     and `code_challenge` as query params. The verifier never leaves the App's
//     cookie.
//
//     /api/trellis-auth/login does the same thing as this branch. It exists so
//     an app's UI can offer an explicit "Sign in" link without first having to
//     hit a guarded page.
//
// 3.  Rails handles the authorize page. If the user is not already signed in,
//     Rails sends them through its own sign-in flow first. Once signed in,
//     Rails checks that the user belongs to the app's school. If they do, Rails
//     mints a one-time "authorization code" tied to (user, app, codeChallenge)
//     with a short TTL, and redirects the browser back to
//     https://<app-host>/api/trellis-auth/callback with `code` and `state` in
//     the URL.
//
//     Note: the redirect URL is fully computed by Rails from the app's known
//     production URL. The App never gets to specify where Rails should send the
//     browser, which prevents a class of "open redirect" attacks.
//
// 4.  /api/trellis-auth/callback is handled by this middleware. We:
//
//       a. Read the state cookie, compare to the `state` in the URL. Reject if
//          they do not match. b. POST { code, code_verifier } to Rails' token
//          endpoint, authenticating ourselves with TRELLIS_APP_API_SECRET. That
//          secret is injected into this deployment's environment by Rails at
//          deploy time and identifies us as the real backend for this app.
//          (Anyone who somehow stole the code off the network would also need
//          this secret to redeem it). c. Rails verifies the code is unused,
//          unexpired, belongs to this app, and that SHA-256(verifier) matches
//          the stored challenge. If all good, Rails issues a long- lived
//          "access token" (prefix tau_, 14-day TTL) along with the user's
//          display name.
//
// 5.  We store the access token + expiry + name in a "session cookie" (HttpOnly
//     so browser JS cannot read it; Secure so it only travels over HTTPS;
//     SameSite=Lax so other sites cannot trigger it). The state cookie is
//     cleared. We redirect the browser back to the original path stashed in the
//     state cookie at step 2.
//
// 6.  The user re-opens /dashboard. This time the middleware sees a valid
//     session cookie and lets the request through. When the page's server code
//     calls the Trellis App SDK, the SDK reads the access token from the cookie
//     and sends it as a bearer token. The Trellis App API recognizes it and
//     runs the call as the signed-in user.
//
// 7.  /api/trellis-auth/logout clears the session cookie and shows a "signed
//     out, close the tab" page. We deliberately do not redirect anywhere: the
//     user's Rails session is still live, so a redirect to / would just trip
//     the guard and immediately re-authorize them, making sign-out look like a
//     no-op.
//
// ---------------------------------------------------------------------
// Anonymous mode
// ---------------------------------------------------------------------
//
// Trellis Apps can also run in "anonymous" mode, where every visitor sees the
// app, and the SDK uses the deployment secret directly for authenticating with
// Rails API. In that mode this middleware is a no-op (the very first check
// returns early and the wrapped handler runs as if withAuth had not been
// applied). The same source file works in both modes; the mode is set at deploy
// time via TRELLIS_APP_AUTH_MODE.
//
// ---------------------------------------------------------------------
// Asset bypass
// ---------------------------------------------------------------------
//
// Static assets (/assets/*, /favicon.ico) bypass the gate even in authenticated
// mode. They come out of the RRv7 client build and are referenced from the
// login flow's rendered pages; gating them would deadlock the redirect chain.
//
// =====================================================================

import {
  AUTH_MODE_AUTHENTICATED,
  ENV_AUTHORIZE_URL,
  ENV_TRELLIS_APP_API_SECRET,
  ENV_TRELLIS_APP_API_URL,
  readAuthMode,
  readEnv
} from "../env.js"
import type { FetchHandler } from "../lambda.js"
import {
  CALLBACK_PATH,
  LOGIN_PATH,
  LOGOUT_PATH,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  STATE_COOKIE,
  STATE_MAX_AGE_SECONDS,
  decodeCookie,
  encodeCookie,
  isSessionLive,
  readCookie,
  type SessionCookie,
  type StateCookie,
  type TrellisUser
} from "./cookies.js"

// Wrap an RRv7 request handler in the Trellis auth layer. The returned
// handler short-circuits the three control paths, gates everything
// else on a live session cookie in authenticated mode, and is a pass-
// through in anonymous mode.
export function withAuth(handler: FetchHandler): FetchHandler {
  return async (request) => {
    if (readAuthMode() !== AUTH_MODE_AUTHENTICATED) return handler(request)

    const url = new URL(request.url)
    const { pathname } = url

    if (isAssetPath(pathname)) return handler(request)
    if (pathname === LOGIN_PATH) return handleLogin(url)
    if (pathname === CALLBACK_PATH) return handleCallback(request, url)
    if (pathname === LOGOUT_PATH) return handleLogout()
    return handleGuard(request, url, handler)
  }
}

// Paths that must remain reachable without authentication: the build's
// hashed asset bundles and the favicon. Anything under /assets/ comes
// out of the RRv7 client build and is referenced from the login flow's
// rendered pages, so gating it would deadlock the redirect chain.
function isAssetPath(pathname: string): boolean {
  return pathname.startsWith("/assets/") || pathname === "/favicon.ico"
}

function handleLogin(url: URL): Promise<Response> {
  return beginAuth(sanitizeNext(url.searchParams.get("next")))
}

// Mint state/verifier/challenge, stash them and `next` in a short-
// lived cookie, redirect the browser to the Rails authorize URL.
async function beginAuth(next: string): Promise<Response> {
  const state = randomBase64Url(32)
  const codeVerifier = randomBase64Url(32)
  const codeChallenge = await sha256Base64Url(codeVerifier)

  // ENV_AUTHORIZE_URL already carries `app_id` baked in by Rails at
  // deploy time, so the middleware never needs to know the app id.
  const authorizeUrl = new URL(readEnv(ENV_AUTHORIZE_URL))
  authorizeUrl.searchParams.set("state", state)
  authorizeUrl.searchParams.set("code_challenge", codeChallenge)

  const stateCookie: StateCookie = { state, codeVerifier, next }
  return redirect(authorizeUrl, [
    setCookieHeader(STATE_COOKIE, encodeCookie(stateCookie), STATE_MAX_AGE_SECONDS)
  ])
}

async function handleCallback(request: Request, url: URL): Promise<Response> {
  const code = url.searchParams.get("code")
  const callbackState = url.searchParams.get("state")
  const stored = decodeCookie<StateCookie>(readCookie(request, STATE_COOKIE))

  if (!code || !callbackState || !stored || stored.state !== callbackState) {
    return new Response("invalid_state", { status: 400 })
  }

  const exchanged = await exchangeCode({
    code,
    codeVerifier: stored.codeVerifier
  })
  if ("error" in exchanged) {
    return new Response(exchanged.error, { status: exchanged.status })
  }

  const target = new URL(stored.next, url.origin)
  return redirect(target, [
    setCookieHeader(
      SESSION_COOKIE,
      encodeCookie(exchanged),
      SESSION_MAX_AGE_SECONDS
    ),
    deleteCookieHeader(STATE_COOKIE)
  ])
}

// Sign-out is purely local to the App: clear the session cookie and
// render a terminal page that does not navigate anywhere. We cannot
// redirect to "/" because the user's Rails session is still live, so
// the guard would immediately re-authorize them.
function handleLogout(): Response {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" })
  headers.append("Set-Cookie", deleteCookieHeader(SESSION_COOKIE))
  return new Response(SIGNED_OUT_PAGE, { status: 200, headers })
}

const SIGNED_OUT_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Signed out</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; color: #222; }
      h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    </style>
  </head>
  <body>
    <h1>Signed out</h1>
    <p>You have been signed out. You can close this tab.</p>
  </body>
</html>
`

function handleGuard(
  request: Request,
  url: URL,
  handler: FetchHandler
): Promise<Response> {
  const session = decodeCookie<SessionCookie>(readCookie(request, SESSION_COOKIE))
  if (isSessionLive(session)) return handler(request)

  return beginAuth(url.pathname + url.search)
}

interface ExchangeFailure {
  error: string
  status: number
}

async function exchangeCode(params: {
  code: string
  codeVerifier: string
}): Promise<SessionCookie | ExchangeFailure> {
  const baseUrl = readEnv(ENV_TRELLIS_APP_API_URL).replace(/\/+$/, "")
  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${readEnv(ENV_TRELLIS_APP_API_SECRET)}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      code: params.code,
      code_verifier: params.codeVerifier
    })
  })

  if (!response.ok) {
    return { error: "token_exchange_failed", status: response.status }
  }

  const body = (await response.json()) as {
    data?: {
      access_token?: string
      expires_at?: string
      user?: TrellisUser
    }
  }
  const data = body.data
  if (!data?.access_token || !data?.expires_at || !data?.user) {
    return { error: "token_exchange_malformed", status: 502 }
  }

  const expiresAtMs = Date.parse(data.expires_at)
  if (!Number.isFinite(expiresAtMs)) {
    return { error: "token_exchange_malformed", status: 502 }
  }

  return {
    accessToken: data.access_token,
    expiresAt: Math.floor(expiresAtMs / 1000),
    user: data.user
  }
}

// Construct a 302 with one Location header and an arbitrary number of
// Set-Cookie headers. Using Headers#append (not set) preserves multiple
// Set-Cookie values, which Headers#set would collapse.
function redirect(location: URL | string, setCookies: string[]): Response {
  const headers = new Headers({ Location: location.toString() })
  for (const value of setCookies) headers.append("Set-Cookie", value)
  return new Response(null, { status: 302, headers })
}

function setCookieHeader(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`
}

function deleteCookieHeader(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

// Restrict `next` to a same-origin path. Anything else (absolute URL,
// protocol-relative URL, scheme/auth/host) falls back to "/" so the
// login flow cannot be coerced into an open redirect.
function sanitizeNext(value: string | null): string {
  if (!value) return "/"
  if (!value.startsWith("/") || value.startsWith("//")) return "/"
  return value
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString("base64url")
}

async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return Buffer.from(digest).toString("base64url")
}
