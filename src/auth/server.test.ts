import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runWithRequest } from "../context.js"
import { signedCookieHeader } from "../cookies.js"
import { SESSION_COOKIE, type SessionCookie } from "./cookies.js"
import { getTrellisUser } from "./server.js"

function requestWithCookie(cookie: string | null): Request {
  const headers = new Headers()
  if (cookie !== null) headers.set("cookie", cookie)
  return new Request("https://endor.apps.collegevine.ai/", { headers })
}

function signedSession(session: SessionCookie): string {
  return signedCookieHeader({ name: SESSION_COOKIE, value: session, maxAgeSeconds: 3600 }).split(";")[0]!
}

const frodo: SessionCookie = {
  accessToken: "tau_speak-friend",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  user: {
    name: "Frodo Baggins",
    emailHashes: [
      "9ff3ef89857528ef80c5fa0faa27e4e5902d2d342d8fd9086c40d296fd49a709"
    ],
    subjectType: "constituent"
  }
}

describe("getTrellisUser", () => {
  beforeEach(() => process.env.TRELLIS_APP_AUTH_MODE = "authenticated")
  afterEach(() => delete process.env.TRELLIS_APP_AUTH_MODE)

  it("returns the user when a live signed session cookie is on the request", () => {
    const user = runWithRequest(
      { request: requestWithCookie(signedSession(frodo)) },
      () => getTrellisUser()
    )
    expect(user).toEqual(frodo.user)
  })

  it("returns null in anonymous mode even with a validly signed session", () => {
    process.env.TRELLIS_APP_AUTH_MODE = "anonymous"
    const user = runWithRequest(
      { request: requestWithCookie(signedSession(frodo)) },
      () => getTrellisUser()
    )
    expect(user).toBeNull()
  })

  it("returns null when the session cookie's subjectType was edited", () => {
    const [name, value] = signedSession(frodo).split(/=(.*)/s) as [string, string]
    const envelope = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    const payload = JSON.parse(envelope.payload)
    payload.user.subjectType = "hq_user"
    envelope.payload = JSON.stringify(payload)
    const tampered = Buffer.from(JSON.stringify(envelope)).toString("base64url")
    const user = runWithRequest(
      { request: requestWithCookie(`${name}=${tampered}`) },
      () => getTrellisUser()
    )
    expect(user).toBeNull()
  })

  it("returns null when the cookie is missing or the session has expired", () => {
    const expired = signedSession({
      ...frodo,
      expiresAt: Math.floor(Date.now() / 1000) - 1
    })
    for (const cookie of [null, "theme=tatooine; lang=westron", expired]) {
      const user = runWithRequest(
        { request: requestWithCookie(cookie) },
        () => getTrellisUser()
      )
      expect(user).toBeNull()
    }
  })

  it("throws when called outside a request scope", () => {
    expect(() => getTrellisUser()).toThrow(/outside a request scope/)
  })
})
