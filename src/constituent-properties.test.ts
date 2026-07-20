import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getConstituentProperties, TrellisAppApiError } from "../src/index.js"

const BASE_URL = "https://api.example.com/trellis/apps/api/v1/"
const SECRET = "tas_speak-friend-and-enter"

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

describe("getConstituentProperties", () => {
  it("POSTs the keys as JSON with bearer auth and unwraps the property map", async () => {
    const properties = { house_key: "Gryffindor", owls_key: 5 }
    fetchMock.mockResolvedValue(jsonResponse(200, { data: properties }))

    const result = await getConstituentProperties(["house_key", "owls_key"])

    expect(result).toEqual(properties)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [calledUrl, init] = fetchMock.mock.calls[0]!
    expect(calledUrl).toBe(
      "https://api.example.com/trellis/apps/api/v1/constituent-properties"
    )
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`)
    expect(init.headers["Content-Type"]).toBe("application/json")
    expect(JSON.parse(init.body as string)).toEqual({
      keys: ["house_key", "owls_key"]
    })
  })

  it("throws TrellisAppApiError with status 422 when the subject is not a constituent", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        error: "not_a_constituent",
        message: "Must be signed in as a constituent"
      })
    )

    const error = await captureError(() => getConstituentProperties(["house_key"]))

    expect(error).toBeInstanceOf(TrellisAppApiError)
    expect((error as TrellisAppApiError).status).toBe(422)
    expect((error as TrellisAppApiError).body).toMatchObject({
      error: "not_a_constituent"
    })
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
