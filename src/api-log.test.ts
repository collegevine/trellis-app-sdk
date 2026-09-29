import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { queryTinybirdPipe, TrellisAppApiError } from "./index.js"
import { Logger } from "./logging.js"
import { withAuth } from "./auth/rrv7-middleware.js"
import { CALLBACK_PATH, STATE_COOKIE, encodeCookie, type StateCookie } from "./auth/cookies.js"

const BASE_URL = "https://api.example.com/trellis/apps/api/v1/"
const SECRET = "tas_speak-friend-and-enter"
const PIPE = "agents__count"
const PARAMS = {
  mode: "total",
  action_or_event_id: ["email-opened"],
  date_range_after: "2026-09-21 05:00:00",
  date_range_before: "2026-09-28 05:00:00"
} as const
const QUERY =
  "mode=total&action_or_event_id=email-opened" +
  "&date_range_after=2026-09-21+05%3A00%3A00&date_range_before=2026-09-28+05%3A00%3A00"

const fetchMock = vi.fn()

describe("API call logging", () => {
  let logged: unknown[][]

  beforeEach(() => {
    logged = []
    vi.spyOn(Logger, "debug").mockImplementation((...args: unknown[]) => {
      logged.push(args)
    })
    vi.stubGlobal("fetch", fetchMock)
    vi.stubEnv("TRELLIS_APP_API_URL", BASE_URL)
    vi.stubEnv("TRELLIS_APP_API_SECRET", SECRET)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("logs the endpoint, method, query string, and status of a call", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: { data: [], meta: [], rows: 0 } })
    )

    await queryTinybirdPipe(PIPE, PARAMS)

    expect(logged).toEqual([
      [
        "API call",
        {
          path: "/trellis/apps/api/v1/tinybird/agents__count",
          method: "GET",
          query: QUERY,
          status: 200,
          durationMs: expect.any(Number)
        }
      ]
    ])
  })

  it("logs the status of a call the API refused, which the SDK throws on", async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: "school_not_provisioned" }))

    await expect(queryTinybirdPipe(PIPE, PARAMS)).rejects.toBeInstanceOf(TrellisAppApiError)

    expect(logged[0]).toEqual([
      "API call",
      {
        path: "/trellis/apps/api/v1/tinybird/agents__count",
        method: "GET",
        query: QUERY,
        status: 409,
        durationMs: expect.any(Number)
      }
    ])
  })

  it("logs why a call never reached the API, truncating a long failure", async () => {
    const detail = "socket hang up ".repeat(100)
    fetchMock.mockRejectedValue(new Error(detail))

    await expect(queryTinybirdPipe(PIPE, PARAMS)).rejects.toThrow(detail)

    const fields = logged[0]![1] as Record<string, unknown>
    expect(fields.status).toBeUndefined()
    expect(fields.error).toBe(`${detail.slice(0, 500)}…`)
  })

  it("logs the OAuth token exchange the auth middleware makes", async () => {
    vi.stubEnv("TRELLIS_APP_AUTH_MODE", "authenticated")
    vi.stubEnv("TRELLIS_APP_AUTHORIZE_URL", "https://collegevine.com/oauth/authorize")
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: {
          access_token: "tau_kessel-run",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          user: { name: "Han Solo", email_hashes: [], subject_type: "constituent" }
        }
      })
    )
    const state: StateCookie = {
      state: "round-trip-state",
      codeVerifier: "verifier-secret",
      next: "/dashboard"
    }

    await withAuth(async () => new Response("unreached"))(
      new Request(
        `https://falcon.tatooine.apps.collegevine.ai${CALLBACK_PATH}?code=one-time-code&state=round-trip-state`,
        { headers: { cookie: `${STATE_COOKIE}=${encodeCookie(state)}` } }
      )
    )

    expect(logged[0]).toEqual([
      "API call",
      {
        path: "/trellis/apps/api/v1/oauth/token",
        method: "POST",
        status: 200,
        durationMs: expect.any(Number)
      }
    ])
  })
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  })
}
