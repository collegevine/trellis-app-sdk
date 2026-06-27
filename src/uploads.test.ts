import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { uploadFile, TrellisAppApiError } from "../src/index.js"

const BASE_URL = "https://api.example.com/trellis/apps/api/v1/"
const SECRET = "tas_use-the-force-luke"
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

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

describe("uploadFile", () => {
  it("POSTs the raw bytes with the given content type and bearer auth, passing the filename in the query, unwrapping the envelope", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { upload_id: "abc-123" } }))

    const result = await uploadFile(BYTES, "image/png", "x wing.png")

    expect(result).toEqual({ upload_id: "abc-123" })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [calledUrl, init] = fetchMock.mock.calls[0]!
    expect(calledUrl).toBe(
      "https://api.example.com/trellis/apps/api/v1/uploads?filename=x%20wing.png"
    )
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`)
    expect(init.headers["Content-Type"]).toBe("image/png")
    expect(init.body).toBe(BYTES)
  })

  it("throws TrellisAppApiError with status and parsed body on non-2xx", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: "unsupported_file_type", message: "nope" })
    )

    const error = await captureError(() => uploadFile(BYTES, "application/zip", "evil.zip"))

    expect(error).toBeInstanceOf(TrellisAppApiError)
    expect(error).toMatchObject({ status: 400, body: { error: "unsupported_file_type" } })
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
