import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runWithRequest } from "../context.js"
import { request as apiRequest } from "../http.js"
import { createLambdaHandler } from "../lambda.js"
import {
  CALLBACK_PATH, encodeCookie, SESSION_COOKIE, STATE_COOKIE, type SessionCookie
} from "./cookies.js"
import { withAuth } from "./rrv7-middleware.js"
import { getTrellisUser } from "./server.js"

const SIGNING_KEY = "TRELLIS_APP_SESSION_SIGNING_KEY"
const session = (): SessionCookie => ({
  accessToken: "tau_test-only",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  user: { name: "Student", emailHashes: ["a".repeat(64)], subjectType: "constituent" }
})
const rawCookie = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")

function editCookie(cookie: string, edit: (value: SessionCookie) => void): string {
  const parts = cookie.split(".")
  const value = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"))
  edit(value)
  parts[1] = rawCookie(value)
  return parts.join(".")
}

function requestFor(cookie: string): Request {
  return new Request("https://test.apps.collegevine.ai/admin", {
    headers: { cookie: `${SESSION_COOKIE}=${cookie}` }
  })
}

beforeEach(() => {
  vi.stubEnv(SIGNING_KEY, "ab".repeat(32))
  vi.stubEnv("TRELLIS_APP_AUTH_MODE", "authenticated")
  vi.stubEnv("TRELLIS_APP_AUTHORIZE_URL", "https://platform.example/authorize?app_id=test")
  vi.stubEnv("TRELLIS_APP_API_URL", "https://platform.example/api")
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("session integrity across SDK entry points", () => {
  it("allows real admin sessions but rejects editing a constituent into an admin", async () => {
    const admin = vi.fn(async () => new Response(null, {
      status: getTrellisUser()?.subjectType === "hq_user" ? 200 : 403
    }))
    const guarded = withAuth(admin)
    const call = (cookie: string) => {
      const request = requestFor(cookie)
      return runWithRequest({ request }, () => guarded(request))
    }
    const original = encodeCookie(session())
    expect((await call(original)).status).toBe(403)
    admin.mockClear()
    const edited = editCookie(original, value => { value.user.subjectType = "hq_user" })
    expect((await call(edited)).status).toBe(302)
    expect(admin).not.toHaveBeenCalled()
    const realAdmin = session()
    realAdmin.user.subjectType = "hq_user"
    expect((await call(encodeCookie(realAdmin))).status).toBe(200)
  })

  it.each([
    ["role", (value: SessionCookie) => { value.user.subjectType = "hq_user" }],
    ["email", (value: SessionCookie) => { value.user.emailHashes = ["b".repeat(64)] }],
    ["expiry", (value: SessionCookie) => { value.expiresAt += 86400 }],
    ["token", (value: SessionCookie) => { value.accessToken = "tau_different" }]
  ] as const)("rejects a modified %s even without the route middleware", async (_, edit) => {
    const request = requestFor(editCookie(encodeCookie(session()), edit))
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    expect(runWithRequest({ request }, () => getTrellisUser())).toBeNull()
    await expect(runWithRequest({ request }, () => apiRequest("/test"))).rejects.toMatchObject({ status: 401 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("does not upgrade an unsigned session into a trusted identity", () => {
    const request = requestFor(rawCookie(session()))
    expect(runWithRequest({ request }, () => getTrellisUser())).toBeNull()
  })

  it("rejects a session signed by another app or a retired key", () => {
    const request = requestFor(encodeCookie(session()))
    vi.stubEnv(SIGNING_KEY, "cd".repeat(32))
    expect(runWithRequest({ request }, () => getTrellisUser())).toBeNull()
  })

  it("does not accept a login-state signature as a session signature", () => {
    const request = requestFor(encodeCookie(session(), STATE_COOKIE))
    expect(runWithRequest({ request }, () => getTrellisUser())).toBeNull()
  })

  it.each(["unsigned", "edited", "expired", "wrong-purpose"])("rejects %s login state before exchanging a code", async mode => {
    const state = { state: "s", codeVerifier: "v", next: "/", expiresAt: Math.floor(Date.now() / 1000) + 600 }
    let cookie = encodeCookie(state, STATE_COOKIE)
    if (mode === "unsigned") cookie = rawCookie(state)
    if (mode === "edited") cookie = cookie.replace(cookie.split(".")[1]!, rawCookie({ ...state, next: "/admin" }))
    if (mode === "expired") cookie = encodeCookie({ ...state, expiresAt: 0 }, STATE_COOKIE)
    if (mode === "wrong-purpose") cookie = encodeCookie(state)
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const handler = vi.fn(async () => new Response("unexpected"))
    const response = await withAuth(handler)(new Request(
      `https://test.apps.collegevine.ai${CALLBACK_PATH}?code=c&state=s`,
      { headers: { cookie: `${STATE_COOKIE}=${cookie}` } }
    ))
    expect(response.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it.each([undefined, "", "too-short", "z".repeat(64)])("fails closed with an invalid signing key: %s", key => {
    const request = requestFor(encodeCookie(session()))
    vi.stubEnv(SIGNING_KEY, key)
    expect(() => runWithRequest({ request }, () => getTrellisUser())).toThrow(/SIGNING_KEY/)
    expect(() => encodeCookie(session())).toThrow(/SIGNING_KEY/)
  })

  it("requires the signing key before beginning an authenticated login", async () => {
    vi.stubEnv(SIGNING_KEY, undefined)
    const handler = vi.fn(async () => new Response("unexpected"))
    await expect(withAuth(handler)(requestFor(""))).rejects.toThrow(/SIGNING_KEY/)
    expect(handler).not.toHaveBeenCalled()
  })

  it("does not require a signing key for an anonymous request", async () => {
    vi.stubEnv(SIGNING_KEY, undefined)
    vi.stubEnv("TRELLIS_APP_AUTH_MODE", "anonymous")
    const response = await withAuth(async () => new Response("public"))(requestFor(""))
    expect(await response.text()).toBe("public")
  })

  it("ignores stale auth cookies in anonymous Lambda requests, including logging", async () => {
    vi.stubEnv(SIGNING_KEY, undefined)
    vi.stubEnv("TRELLIS_APP_AUTH_MODE", "anonymous")
    const handler = createLambdaHandler(withAuth(async () => {
      expect(getTrellisUser()).toBeNull()
      return new Response("public")
    }))
    const response = await handler({
      rawPath: "/",
      headers: {},
      cookies: [`${SESSION_COOKIE}=${rawCookie(session())}`],
      requestContext: { domainName: "test.apps.collegevine.ai", http: { method: "GET" } }
    }, { awsRequestId: "test-request" })
    expect(response.statusCode).toBe(200)
    expect(response.body).toBe("public")
  })
})
