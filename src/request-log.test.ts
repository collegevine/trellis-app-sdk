import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { encodeCookie, SESSION_COOKIE } from "./auth/cookies.js"
import type { TrellisUser } from "./auth/server.js"
import { runWithRequest } from "./context.js"
import { Logger } from "./logging.js"
import { logRequestEnd, logRequestStart } from "./request-log.js"

describe("request logging", () => {
  let logged: unknown[][]

  beforeEach(() => {
    logged = []
    vi.spyOn(Logger, "info").mockImplementation((...args: unknown[]) => {
      logged.push(args)
    })
  })

  afterEach(() => vi.restoreAllMocks())

  const leia: TrellisUser = {
    name: "Leia Organa",
    emailHashes: ["a1b2c3", "d4e5f6"],
    subjectType: "school_user"
  }

  function signedInCookie(user: TrellisUser): string {
    const value = encodeCookie({
      accessToken: "tau_secret",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      user
    })
    return `${SESSION_COOKIE}=${value}`
  }

  it("logs path, query, client ip, and the signed-in user's identity on start", () => {
    const request = new Request(
      "https://x-wing.dagobah.apps.collegevine.ai/dashboard?tab=orders&page=2",
      {
        headers: {
          cookie: signedInCookie(leia),
          "x-trellis-client-ip": "203.0.113.7"
        }
      }
    )

    runWithRequest({ request }, () => logRequestStart(request))

    expect(logged[0]).toEqual([
      "request start",
      {
        path: "/dashboard",
        query: "tab=orders&page=2",
        clientIp: "203.0.113.7",
        user: {
          type: "school_user",
          name: "Leia Organa",
          emailHashes: ["a1b2c3", "d4e5f6"]
        }
      }
    ])
  })

  it("omits query, client ip, and user fields when the request carries none", () => {
    const request = new Request("https://x-wing.dagobah.apps.collegevine.ai/")

    runWithRequest({ request }, () => logRequestStart(request))

    expect(logged[0]).toEqual(["request start", { path: "/" }])
  })

  it("logs path, status, and the elapsed duration on end", () => {
    const request = new Request("https://x-wing.dagobah.apps.collegevine.ai/checkout")

    logRequestEnd({ request, status: 201, durationMs: 42 })

    expect(logged[0]).toEqual([
      "request end",
      { path: "/checkout", status: 201, durationMs: 42 }
    ])
  })
})
