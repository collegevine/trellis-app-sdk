import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { querySlate, TrellisAppApiError } from "../src/index.js"

const BASE_URL = "https://api.example.com/trellis/apps/api/v1/"
const SECRET = "tas_speak-friend-and-enter"
const QUERY = "SELECT first_name, last_name FROM hobbits"

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  process.env.TRELLIS_APP_API_URL = BASE_URL
  process.env.TRELLIS_APP_API_SECRET = SECRET
  fetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.TRELLIS_APP_API_URL
  delete process.env.TRELLIS_APP_API_SECRET
})

describe("querySlate", () => {
  it("POSTs the query as JSON with bearer auth and unwraps the envelope", async () => {
    const slateBody = {
      columns: ["first_name", "last_name"],
      rows: [
        ["Frodo", "Baggins"],
        ["Samwise", "Gamgee"]
      ]
    }
    fetchMock.mockResolvedValue(jsonResponse(200, { data: slateBody }))

    const result = await querySlate(QUERY)

    expect(result).toEqual(slateBody)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [calledUrl, init] = fetchMock.mock.calls[0]!
    expect(calledUrl).toBe(
      "https://api.example.com/trellis/apps/api/v1/slate"
    )
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`)
    expect(init.headers.Accept).toBe("application/json")
    expect(init.headers["Content-Type"]).toBe("application/json")
    expect(JSON.parse(init.body as string)).toEqual({ query: QUERY })
  })

  it("throws TrellisAppApiError with status and parsed body on non-2xx", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: "slate_sql_error",
        message: "Invalid column 'nazgul'."
      })
    )

    const error = await captureError(() => querySlate("SELECT nazgul FROM mordor"))

    expect(error).toBeInstanceOf(TrellisAppApiError)
    expect(error).toMatchObject({
      name: "TrellisAppApiError",
      status: 400,
      body: { error: "slate_sql_error", message: "Invalid column 'nazgul'." }
    })
  })

  it("throws TrellisAppApiError when slate_not_configured comes back as 422", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, { error: "slate_not_configured", message: "..." })
    )

    const error = await captureError(() => querySlate(QUERY))

    expect(error).toBeInstanceOf(TrellisAppApiError)
    expect((error as TrellisAppApiError).status).toBe(422)
    expect((error as TrellisAppApiError).body).toMatchObject({
      error: "slate_not_configured"
    })
  })

  it("throws TrellisAppApiError when a 2xx response is not JSON", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>this is fine</html>", { status: 200 })
    )

    const error = await captureError(() => querySlate(QUERY))

    expect(error).toBeInstanceOf(TrellisAppApiError)
    expect((error as TrellisAppApiError).status).toBe(200)
  })

  it("returns a non-JSON error body verbatim as a string", async () => {
    fetchMock.mockResolvedValue(new Response("upstream barfed", { status: 502 }))

    const error = await captureError(() => querySlate(QUERY))

    expect(error).toBeInstanceOf(TrellisAppApiError)
    expect((error as TrellisAppApiError).status).toBe(502)
    expect((error as TrellisAppApiError).body).toBe("upstream barfed")
  })

  it("throws if TRELLIS_APP_API_URL is missing", async () => {
    delete process.env.TRELLIS_APP_API_URL
    await expect(querySlate(QUERY)).rejects.toThrow(/TRELLIS_APP_API_URL/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("throws if TRELLIS_APP_API_SECRET is missing", async () => {
    delete process.env.TRELLIS_APP_API_SECRET
    await expect(querySlate(QUERY)).rejects.toThrow(/TRELLIS_APP_API_SECRET/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("normalizes a base URL with no trailing slash", async () => {
    process.env.TRELLIS_APP_API_URL =
      "https://api.example.com/trellis/apps/api/v1"
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: { columns: [], rows: [] } })
    )

    await querySlate(QUERY)

    const [calledUrl] = fetchMock.mock.calls[0]!
    expect(calledUrl).toBe(
      "https://api.example.com/trellis/apps/api/v1/slate"
    )
  })

  it("reads env vars per call, not at module load", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { data: { columns: [], rows: [] } }))
    )

    process.env.TRELLIS_APP_API_URL = "https://first.example.com/v1/"
    process.env.TRELLIS_APP_API_SECRET = "tas_first"
    await querySlate(QUERY)

    process.env.TRELLIS_APP_API_URL = "https://second.example.com/v1/"
    process.env.TRELLIS_APP_API_SECRET = "tas_second"
    await querySlate(QUERY)

    const [firstUrl, firstInit] = fetchMock.mock.calls[0]!
    const [secondUrl, secondInit] = fetchMock.mock.calls[1]!
    expect(firstUrl).toContain("first.example.com")
    expect(firstInit.headers.Authorization).toBe("Bearer tas_first")
    expect(secondUrl).toContain("second.example.com")
    expect(secondInit.headers.Authorization).toBe("Bearer tas_second")
  })
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  })
}

async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (err) {
    return err
  }
  throw new Error("Expected function to throw, but it did not")
}
