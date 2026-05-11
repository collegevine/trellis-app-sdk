// =====================================================================
// AUTH FLOW. Basically OAuth, but somewhat simpler.
// =====================================================================
//
// What this file does:
//
// A "Trellis App" is a small web app that other people deploy. We
// want some of those apps to require sign-in. The user signs in
// against the main CollegeVine site (where their account already
// lives), not against the deployed app, so the app does not have to
// store passwords or run its own auth UI. After sign-in, the app
// gets a credential it can use to call the Trellis App API on the
// signed-in user's behalf.
//
// This middleware orchestrates that whole dance. The deployed app
// imports it and does nothing else. Every request that hits the app
// flows through here first.
//
// ---------------------------------------------------------------------
// The participants
// ---------------------------------------------------------------------
//
//   Browser:  the user's browser.
//   App:      this deployed app. Has a server side (where this
//             middleware runs) and the pages it serves.
//   Rails:    the main CollegeVine Rails app at collegevine.com.
//             Knows who the user is, what school they belong to, and
//             which Trellis Apps exist. We talk to two endpoints
//             on Rails: an "authorize" page (browser-facing) and a
//             "token" endpoint (server-to-server).
//
// ---------------------------------------------------------------------
// The flow, step by step
// ---------------------------------------------------------------------
//
// 1.  User opens https://<app-host>/dashboard.
//
// 2.  Middleware looks for a "session cookie" on the request. None,
//     or it has expired. Right here in the response to this same
//     request, the middleware generates two pieces of secret data:
//
//       state         a random value, stored in a short-lived
//                     cookie. We will see this value come back in
//                     the URL when Rails sends the user back; if
//                     the cookie value and the URL value do not
//                     match, we know the round-trip was tampered
//                     with and reject it. This blocks an attacker
//                     who tricks the victim into starting a flow
//                     under the attacker's control.
//
//       codeVerifier  a random secret, also stored in the same
//                     short-lived cookie. We hash it with SHA-256
//                     to produce a `codeChallenge` that we send up
//                     to Rails. Later, Rails will hand us a
//                     one-time code, and we will hand back the
//                     verifier; Rails re-hashes it and checks that
//                     the result matches the challenge it stored.
//                     This proves the entity redeeming the code is
//                     the same one that started the flow, even if
//                     the code itself leaks (e.g. via referer
//                     headers or browser history).
//
//     The original path (/dashboard) is also stashed in the same
//     short-lived cookie so we can send the user back there at the
//     end. The middleware then 302s the browser to the Rails
//     authorize page, passing `app_id`, `state`, and `code_challenge`
//     as query params. The verifier never leaves the App's cookie.
//
//     /api/trellis-auth/login does the same thing as this branch.
//     It exists so an app's UI can offer an explicit "Sign in" link
//     without first having to hit a guarded page.
//
// 3.  Rails handles the authorize page. If the user is not already
//     signed in, Rails sends them through its own sign-in flow
//     first. Once signed in, Rails checks that the user belongs to
//     the app's school. If they do, Rails mints a one-time
//     "authorization code" tied to (user, app, codeChallenge) with
//     a short TTL, and redirects the browser back to
//     https://<app-host>/api/trellis-auth/callback with `code` and
//     `state` in the URL.
//
//     Note: the redirect URL is fully computed by Rails from the
//     app's known production URL. The App never gets to specify
//     where Rails should send the browser, which prevents a class
//     of "open redirect" attacks.
//
// 4.  /api/trellis-auth/callback is handled by this middleware.
//     We:
//
//       a. Read the state cookie, compare to the `state` in the
//          URL. Reject if they do not match.
//       b. POST { code, code_verifier } to Rails' token endpoint,
//          authenticating ourselves with TRELLIS_APP_API_SECRET.
//          That secret is injected into this deployment's
//          environment by Rails at deploy time and identifies us
//          as the real backend for this app. (Anyone who somehow
//          stole the code off the network would also need this
//          secret to redeem it).
//       c. Rails verifies the code is unused, unexpired, belongs
//          to this app, and that SHA-256(verifier) matches the
//          stored challenge. If all good, Rails issues a long-
//          lived "access token" (prefix tau_, 14-day TTL) along
//          with the user's display name.
//
// 5.  We store the access token + expiry + name in a "session
//     cookie" (HttpOnly so browser JS cannot read it; Secure so
//     it only travels over HTTPS; SameSite=Lax so other sites
//     cannot trigger it). The state cookie is cleared. We
//     redirect the browser back to the original path stashed in
//     the state cookie at step 2.
//
// 6.  The user re-opens /dashboard. This time the middleware sees
//     a valid session cookie and lets the request through. When
//     the page's server code calls the Trellis App SDK, the SDK
//     reads the access token from the cookie and sends it as a
//     bearer token. The Trellis App API recognizes it and runs
//     the call as the signed-in user.
//
// 7.  /api/trellis-auth/logout clears the session cookie and shows a
//     "signed out, close the tab" page. We deliberately do not
//     redirect anywhere: the user's Rails session is still live, so
//     a redirect to / would just trip the guard and immediately
//     re-authorize them, making sign-out look like a no-op.
//
// ---------------------------------------------------------------------
// Anonymous mode
// ---------------------------------------------------------------------
//
// Trellis Apps can also run in "anonymous" mode, where every
// visitor sees the app and the SDK uses the deployment secret
// directly. In that mode this middleware is a no-op (the very
// first check returns early). The same source file works in both
// modes; the mode is set at deploy time via TRELLIS_APP_AUTH_MODE.
//
// =====================================================================

import { NextResponse, type NextRequest } from "next/server.js"
import {
  AUTH_MODE_AUTHENTICATED,
  ENV_AUTHORIZE_URL,
  ENV_TRELLIS_APP_API_URL,
  ENV_TRELLIS_APP_API_SECRET,
  readAuthMode,
  readEnv
} from "../env.js"
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
  type SessionCookie,
  type StateCookie,
  type TrellisUser
} from "./cookies.js"

// Next.js middleware for authenticated-mode Trellis Apps. Anonymous-mode
// apps should not import this — its cost is zero in that case (the
// first check returns NextResponse.next), but mounting it implies an
// authenticated app to anyone reading the source.
//
// Behavior:
//   - The three auth control paths (login / callback / logout) are
//     served by the middleware itself, so the agent does not need to
//     create any route handlers.
//   - Every other path is gated: missing or expired session cookie
//     redirects the user through /api/trellis-auth/login, preserving
//     the original URL in the `next` query param for post-login
//     return.
//   - On anonymous-mode deployments the middleware no-ops, which lets
//     the same source file ship to either mode.
export async function middleware(request: NextRequest): Promise<NextResponse> {
  if (readAuthMode() !== AUTH_MODE_AUTHENTICATED) {
    return NextResponse.next()
  }

  const { pathname } = request.nextUrl
  if (pathname === LOGIN_PATH) return handleLogin(request)
  if (pathname === CALLBACK_PATH) return handleCallback(request)
  if (pathname === LOGOUT_PATH) return handleLogout(request)
  return handleGuard(request)
}

// Run the middleware on every path except Next.js internals and static
// assets. Public assets that need to bypass the gate should be served
// from /_next/* or have their requests fall under one of these
// exclusions.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
}

// Explicit entry point for "Sign in" links in the app's UI. Reads
// the `next` query param (defaulting to "/" and rejecting anything
// that is not a same-origin path) and otherwise does the same work
// as the guard's unauthenticated branch.
function handleLogin(request: NextRequest): Promise<NextResponse> {
  return beginAuth(sanitizeNext(request.nextUrl.searchParams.get("next")))
}

// Mint state/verifier/challenge, stash them and `next` in a short-
// lived cookie, and redirect the browser to the Rails authorize URL.
// Shared by the explicit /api/trellis-auth/login entry point and by
// the page-guard branch so a guarded-page request triggers exactly
// one redirect instead of bouncing through /login first.
async function beginAuth(next: string): Promise<NextResponse> {
  const state = randomBase64Url(32)
  const codeVerifier = randomBase64Url(32)
  const codeChallenge = await sha256Base64Url(codeVerifier)

  // ENV_AUTHORIZE_URL already carries `app_id` as a query param: Rails
  // bakes it in at deploy time, so the middleware never needs to know
  // which app it is running inside.
  const authorizeUrl = new URL(readEnv(ENV_AUTHORIZE_URL))
  authorizeUrl.searchParams.set("state", state)
  authorizeUrl.searchParams.set("code_challenge", codeChallenge)

  const response = NextResponse.redirect(authorizeUrl)
  const stateCookie: StateCookie = { state, codeVerifier, next }
  response.cookies.set(STATE_COOKIE, encodeCookie(stateCookie), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: STATE_MAX_AGE_SECONDS
  })
  return response
}

// Where Rails sends the browser at the end of the authorize step.
// Verifies the round-trip was not tampered with by checking the
// `state` param against the state cookie, exchanges the one-time
// code (plus the PKCE verifier from the same cookie) for a long-
// lived access token via Rails' server-to-server token endpoint,
// then sets the session cookie and redirects the browser to the
// path that originally kicked off the flow.
async function handleCallback(request: NextRequest): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get("code")
  const callbackState = request.nextUrl.searchParams.get("state")
  const storedRaw = request.cookies.get(STATE_COOKIE)?.value
  const stored = decodeCookie<StateCookie>(storedRaw)

  if (!code || !callbackState || !stored || stored.state !== callbackState) {
    return new NextResponse("invalid_state", { status: 400 })
  }

  const exchanged = await exchangeCode({ code, codeVerifier: stored.codeVerifier })
  if ("error" in exchanged) {
    return new NextResponse(exchanged.error, { status: exchanged.status })
  }

  const response = NextResponse.redirect(absoluteUrl(request, stored.next))
  response.cookies.set(SESSION_COOKIE, encodeCookie(exchanged), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS
  })
  response.cookies.delete(STATE_COOKIE)
  return response
}

// Sign-out is purely local to the App: clear the session cookie and
// render a terminal page that does not navigate anywhere. We cannot
// redirect to "/" because the user's Rails session is still live, so
// the guard would immediately re-authorize them and sign-out would
// look like a no-op. Telling them to close the tab is the honest
// answer until we have a real cross-site sign-out story.
function handleLogout(_request: NextRequest): NextResponse {
  const response = new NextResponse(SIGNED_OUT_PAGE, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  })
  response.cookies.delete(SESSION_COOKIE)
  return response
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

// Default handler for every path that is not one of the three auth control
// paths. If the session cookie is present and not expired, the request flows
// through to the page. Otherwise we start a new auth flow, remembering the
// current path + query so the user lands back here after sign-in.
function handleGuard(request: NextRequest): Promise<NextResponse> {
  const session = decodeCookie<SessionCookie>(
    request.cookies.get(SESSION_COOKIE)?.value
  )
  if (isSessionLive(session)) return Promise.resolve(NextResponse.next())

  return beginAuth(request.nextUrl.pathname + request.nextUrl.search)
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

// Restrict `next` to a same-origin path. Anything else (absolute URL,
// protocol-relative URL, scheme/auth/host) falls back to "/" so the
// login flow cannot be coerced into an open redirect.
function sanitizeNext(value: string | null): string {
  if (!value) return "/"
  if (!value.startsWith("/") || value.startsWith("//")) return "/"
  return value
}

function absoluteUrl(request: NextRequest, path: string): URL {
  return new URL(path, request.nextUrl.origin)
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
