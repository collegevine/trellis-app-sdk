import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FetchHandler } from "../lambda.js"
import {
  CALLBACK_PATH,
  LOGIN_PATH,
  LOGOUT_PATH,
  SESSION_COOKIE,
  STATE_COOKIE,
  type SessionCookie,
  type StateCookie
} from "./cookies.js"
import { readSignedCookie, signedCookieHeader } from "../cookies.js"
import { withAuth } from "./rrv7-middleware.js"

const ORIGIN = "https://millennium-falcon.tatooine.apps.collegevine.ai"
const AUTHORIZE_URL =
  "https://collegevine.com/oauth/authorize?app_id=falcon"
const API_URL = "https://collegevine.com/api"
const API_SECRET = "tau_chewbacca"

function stubAuthMode(mode: "authenticated" | "anonymous"): void {
  vi.stubEnv("TRELLIS_APP_AUTH_MODE", mode)
  vi.stubEnv("TRELLIS_APP_AUTHORIZE_URL", AUTHORIZE_URL)
  vi.stubEnv("TRELLIS_APP_API_URL", API_URL)
  vi.stubEnv("TRELLIS_APP_API_SECRET", API_SECRET)
}

function freshHandler(
  response: Response = new Response("hello")
): { handler: FetchHandler; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(async () => response.clone())
  return { handler: spy as unknown as FetchHandler, spy }
}

function request(
  path: string,
  init: { cookies?: string[]; method?: string } = {}
): Request {
  const headers = new Headers()
  if (init.cookies?.length) headers.set("cookie", init.cookies.join("; "))
  return new Request(`${ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers
  })
}

// The `name=value` pair a browser would send back for a signed cookie.
function signedPair(name: string, value: unknown): string {
  return signedCookieHeader({ name, value, maxAgeSeconds: 600 }).split(";")[0]!
}

// Read a signed value back out of a Set-Cookie header the middleware emitted.
function readSetCookie<T>(setCookie: string, name: string): T | null {
  return readSignedCookie<T>(request("/", { cookies: [setCookie.split(";")[0]!] }), name)
}

const luke: SessionCookie = {
  accessToken: "tau_use-the-force",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  user: { name: "Luke Skywalker", emailHashes: [], subjectType: "school_user" }
}

function stateCookie(state: string, overrides: Partial<StateCookie> = {}): string {
  return signedPair(STATE_COOKIE, {
    state,
    codeVerifier: "verifier-secret",
    next: "/dashboard",
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    ...overrides
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("withAuth in anonymous mode", () => {
  beforeEach(() => stubAuthMode("anonymous"))

  it("passes every request straight through, including auth control paths", async () => {
    const { handler, spy } = freshHandler()
    const guarded = withAuth(handler)

    await guarded(request("/dashboard"))
    await guarded(request(LOGIN_PATH))
    await guarded(request(LOGOUT_PATH))

    expect(spy).toHaveBeenCalledTimes(3)
  })
})

describe("withAuth in authenticated mode", () => {
  beforeEach(() => stubAuthMode("authenticated"))

  it("bypasses the gate for static assets and favicon", async () => {
    const { handler, spy } = freshHandler()
    const guarded = withAuth(handler)

    await guarded(request("/assets/index-abc123.js"))
    await guarded(request("/favicon.ico"))

    expect(spy).toHaveBeenCalledTimes(2)
  })

  it("passes guarded requests through when a live session cookie is present", async () => {
    const { handler, spy } = freshHandler()
    const guarded = withAuth(handler)

    await guarded(request("/dashboard", { cookies: [signedPair(SESSION_COOKIE, luke)] }))

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("sends a session with an edited subjectType, or an unsigned one, back through sign-in", async () => {
    const { handler, spy } = freshHandler()
    const guarded = withAuth(handler)

    const [name, value] = signedPair(SESSION_COOKIE, luke).split(/=(.*)/s) as [string, string]
    const envelope = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    envelope.payload = JSON.stringify({
      ...luke,
      user: { ...luke.user, subjectType: "hq_user" }
    })
    const tampered = `${name}=${Buffer.from(JSON.stringify(envelope)).toString("base64url")}`
    const unsigned = `${name}=${Buffer.from(JSON.stringify(luke)).toString("base64url")}`

    for (const cookie of [tampered, unsigned]) {
      const response = await guarded(request("/dashboard", { cookies: [cookie] }))
      expect(response.status).toBe(302)
      expect(response.headers.get("Location")).toMatch(/^https:\/\/collegevine\.com\/oauth\/authorize/)
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it("redirects guarded requests to the authorize URL when no session is present", async () => {
    const { handler, spy } = freshHandler()
    const guarded = withAuth(handler)

    const response = await guarded(request("/dashboard?ship=falcon"))

    expect(response.status).toBe(302)
    expect(spy).not.toHaveBeenCalled()

    const location = new URL(response.headers.get("Location")!)
    expect(location.origin + location.pathname).toBe(
      "https://collegevine.com/oauth/authorize"
    )
    expect(location.searchParams.get("app_id")).toBe("falcon")
    expect(location.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]+$/)

    const cookies = response.headers.getSetCookie()
    expect(cookies).toHaveLength(1)
    const stashed = readSetCookie<StateCookie>(cookies[0]!, STATE_COOKIE)!
    expect(stashed.state).toBe(location.searchParams.get("state"))
    expect(stashed.next).toBe("/dashboard?ship=falcon")
    const now = Math.floor(Date.now() / 1000)
    expect(stashed.expiresAt).toBeGreaterThanOrEqual(now + 599)
    expect(stashed.expiresAt).toBeLessThanOrEqual(now + 600)
  })

  it("logout returns 200 HTML and clears the session cookie", async () => {
    const { handler, spy } = freshHandler()
    const guarded = withAuth(handler)

    const response = await guarded(request(LOGOUT_PATH))

    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toMatch(/text\/html/)
    expect(spy).not.toHaveBeenCalled()

    const cookies = response.headers.getSetCookie()
    expect(cookies).toHaveLength(1)
    expect(cookies[0]).toMatch(/^__Host-Http-App-[^=]+-trellis_auth=;/)
    expect(cookies[0]).toContain("Max-Age=0")
  })

  it("callback rejects a missing, mismatched, expired, or unsigned state cookie", async () => {
    const { handler } = freshHandler()
    const fetchSpy = vi.fn<typeof fetch>()
    vi.stubGlobal("fetch", fetchSpy)
    const guarded = withAuth(handler)
    const url = `${CALLBACK_PATH}?code=c&state=s`
    const past = Math.floor(Date.now() / 1000) - 1
    const unsigned = stateCookie("s").replace(
      /=.*/s,
      `=${Buffer.from(JSON.stringify({ state: "s", codeVerifier: "v", next: "/", expiresAt: past + 601 })).toString("base64url")}`
    )

    for (const cookies of [
      [],
      [stateCookie("different")],
      [stateCookie("s", { expiresAt: past })],
      [stateCookie("s", { expiresAt: Number.NaN })],
      [unsigned],
      [signedPair(SESSION_COOKIE, { state: "s", codeVerifier: "v", next: "/", expiresAt: past + 601 }).replace("_trellis_auth=", "_trellis_auth_state=")]
    ]) {
      const response = await guarded(request(url, { cookies }))
      expect(response.status).toBe(400)
      expect(await response.text()).toBe("invalid_state")
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("callback exchanges the code, sets the session cookie, clears state, redirects to next", async () => {
    const { handler, spy } = freshHandler()
    const guarded = withAuth(handler)

    const tokenExpiresAt = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString()
    const fetchSpy = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              access_token: "tau_kessel-run",
              expires_at: tokenExpiresAt,
              user: {
                name: "Han Solo",
                email_hashes: [
                  "6d2f3c1e9a8b7c0d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d"
                ],
                subject_type: "constituent"
              }
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    )
    vi.stubGlobal("fetch", fetchSpy)

    const response = await guarded(
      request(`${CALLBACK_PATH}?code=one-time-code&state=round-trip-state`, {
        cookies: [stateCookie("round-trip-state")]
      })
    )

    expect(response.status).toBe(302)
    expect(response.headers.get("Location")).toBe(`${ORIGIN}/dashboard`)
    expect(spy).not.toHaveBeenCalled()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [tokenUrl, tokenInit] = fetchSpy.mock.calls[0]!
    expect(tokenUrl).toBe(`${API_URL}/oauth/token`)
    const tokenBody = JSON.parse(tokenInit!.body as string)
    expect(tokenBody).toEqual({
      code: "one-time-code",
      code_verifier: "verifier-secret"
    })
    expect(tokenInit!.headers).toMatchObject({
      Authorization: `Bearer ${API_SECRET}`
    })

    const cookies = response.headers.getSetCookie()
    expect(cookies).toHaveLength(2)

    const sessionPayload = readSetCookie<SessionCookie>(cookies[0]!, SESSION_COOKIE)!
    expect(sessionPayload.accessToken).toBe("tau_kessel-run")
    // The wire object is snake_case (email_hashes, subject_type); the SDK maps
    // it to the camelCase TrellisUser (emailHashes, subjectType) at the boundary
    // before storing it.
    expect(sessionPayload.user).toEqual({
      name: "Han Solo",
      emailHashes: [
        "6d2f3c1e9a8b7c0d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d"
      ],
      subjectType: "constituent"
    })

    expect(cookies[1]).toMatch(/^__Host-Http-App-[^=]+-trellis_auth_state=;.*Max-Age=0/)
  })

  it("callback surfaces a token-exchange failure as an error response", async () => {
    const { handler } = freshHandler()
    const guarded = withAuth(handler)

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 }))
    )

    const response = await guarded(
      request(`${CALLBACK_PATH}?code=c&state=s`, { cookies: [stateCookie("s")] })
    )

    expect(response.status).toBe(401)
    expect(await response.text()).toBe("token_exchange_failed")
  })
})
