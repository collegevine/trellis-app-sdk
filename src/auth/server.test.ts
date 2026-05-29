import { describe, expect, it } from "vitest"
import { runWithRequest } from "../context.js"
import {
  SESSION_COOKIE,
  encodeCookie,
  type SessionCookie
} from "./cookies.js"
import { getTrellisUser } from "./server.js"

function requestWithCookie(value: string | null): Request {
  const headers = new Headers()
  if (value !== null) headers.set("cookie", `${SESSION_COOKIE}=${value}`)
  return new Request("https://endor.apps.collegevine.ai/", { headers })
}

describe("getTrellisUser", () => {
  it("returns the user when a live session cookie is on the request", () => {
    const session: SessionCookie = {
      accessToken: "tau_speak-friend",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      user: { name: "Frodo Baggins" }
    }
    const user = runWithRequest(
      requestWithCookie(encodeCookie(session)),
      () => getTrellisUser()
    )
    expect(user).toEqual({ name: "Frodo Baggins" })
  })

  it("returns null when no cookie header is present", () => {
    const user = runWithRequest(requestWithCookie(null), () => getTrellisUser())
    expect(user).toBeNull()
  })

  it("returns null when the session has expired", () => {
    const session: SessionCookie = {
      accessToken: "tau_one-ring",
      expiresAt: Math.floor(Date.now() / 1000) - 1,
      user: { name: "Gollum" }
    }
    const user = runWithRequest(
      requestWithCookie(encodeCookie(session)),
      () => getTrellisUser()
    )
    expect(user).toBeNull()
  })

  it("returns null when other cookies are present but not the session cookie", () => {
    const request = new Request("https://endor.apps.collegevine.ai/", {
      headers: { cookie: "theme=tatooine; lang=westron" }
    })
    const user = runWithRequest(request, () => getTrellisUser())
    expect(user).toBeNull()
  })

  it("throws when called outside a request scope", () => {
    expect(() => getTrellisUser()).toThrow(/outside a request scope/)
  })
})
