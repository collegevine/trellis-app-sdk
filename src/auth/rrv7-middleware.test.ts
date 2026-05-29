import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FetchHandler } from "../lambda.js"
import {
  CALLBACK_PATH,
  LOGIN_PATH,
  LOGOUT_PATH,
  SESSION_COOKIE,
  STATE_COOKIE,
  decodeCookie,
  encodeCookie,
  type SessionCookie,
  type StateCookie
} from "./cookies.js"
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
  init: { cookies?: Record<string, string>; method?: string } = {}
): Request {
  const headers = new Headers()
  if (init.cookies && Object.keys(init.cookies).length > 0) {
    const cookie = Object.entries(init.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ")
    headers.set("cookie", cookie)
  }
  return new Request(`${ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers
  })
}

function liveSessionCookie(): string {
  const session: SessionCookie = {
    accessToken: "tau_use-the-force",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    user: { name: "Luke Skywalker" }
  }
  return encodeCookie(session)
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

    await guarded(request("/dashboard", { cookies: { [SESSION_COOKIE]: liveSessionCookie() } }))

    expect(spy).toHaveBeenCalledTimes(1)
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
    expect(cookies[0]).toMatch(new RegExp(`^${STATE_COOKIE}=`))

    const stashed = decodeCookie<StateCookie>(
      cookies[0]!.split(";")[0]!.split("=").slice(1).join("=")
    )!
    expect(stashed.state).toBe(location.searchParams.get("state"))
    expect(stashed.next).toBe("/dashboard?ship=falcon")
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
    expect(cookies[0]).toMatch(new RegExp(`^${SESSION_COOKIE}=;`))
    expect(cookies[0]).toContain("Max-Age=0")
  })

  it("callback rejects when state cookie is missing or mismatched", async () => {
    const { handler } = freshHandler()
    const guarded = withAuth(handler)

    const missing = await guarded(request(`${CALLBACK_PATH}?code=c&state=s`))
    expect(missing.status).toBe(400)

    const mismatch: StateCookie = {
      state: "expected-state",
      codeVerifier: "verifier",
      next: "/"
    }
    const stateCookie = encodeCookie(mismatch)
    const mismatched = await guarded(
      request(`${CALLBACK_PATH}?code=c&state=different`, {
        cookies: { [STATE_COOKIE]: stateCookie }
      })
    )
    expect(mismatched.status).toBe(400)
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
              user: { name: "Han Solo" }
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    )
    vi.stubGlobal("fetch", fetchSpy)

    const stored: StateCookie = {
      state: "round-trip-state",
      codeVerifier: "verifier-secret",
      next: "/dashboard"
    }
    const response = await guarded(
      request(`${CALLBACK_PATH}?code=one-time-code&state=round-trip-state`, {
        cookies: { [STATE_COOKIE]: encodeCookie(stored) }
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

    const sessionCookieRaw = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`))!
    const sessionPayload = decodeCookie<SessionCookie>(
      sessionCookieRaw.split(";")[0]!.split("=").slice(1).join("=")
    )!
    expect(sessionPayload.accessToken).toBe("tau_kessel-run")
    expect(sessionPayload.user.name).toBe("Han Solo")

    const stateCleared = cookies.find((c) => c.startsWith(`${STATE_COOKIE}=`))!
    expect(stateCleared).toContain("Max-Age=0")
  })

  it("callback surfaces a token-exchange failure as an error response", async () => {
    const { handler } = freshHandler()
    const guarded = withAuth(handler)

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 }))
    )

    const stored: StateCookie = {
      state: "s",
      codeVerifier: "v",
      next: "/"
    }
    const response = await guarded(
      request(`${CALLBACK_PATH}?code=c&state=s`, {
        cookies: { [STATE_COOKIE]: encodeCookie(stored) }
      })
    )

    expect(response.status).toBe(401)
    expect(await response.text()).toBe("token_exchange_failed")
  })
})
