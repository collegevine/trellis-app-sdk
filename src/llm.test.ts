import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runLlmInference, TrellisAppApiError, type LlmMessage } from "../src/index.js"

const BASE_URL = "https://api.example.com/trellis/apps/api/v1/"
const SECRET = "tas_use-the-force-luke"
const MESSAGES: LlmMessage[] = [
  { role: "system", content: "You are a wise Jedi Master." },
  { role: "user", content: "Teach me about the Force." }
]

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

describe("runLlmInference", () => {
  it("POSTs the messages as JSON with bearer auth and unwraps the envelope", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: { text: "Do or do not. There is no try." } })
    )

    const result = await runLlmInference(MESSAGES)

    expect(result).toEqual({ text: "Do or do not. There is no try." })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [calledUrl, init] = fetchMock.mock.calls[0]!
    expect(calledUrl).toBe("https://api.example.com/trellis/apps/api/v1/llm")
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`)
    expect(init.headers["Content-Type"]).toBe("application/json")
    expect(JSON.parse(init.body as string)).toEqual({ messages: MESSAGES, upload_ids: [] })
  })

  it("throws TrellisAppApiError with status and parsed body on non-2xx", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(429, { error: "llm_rate_limited", message: "slow down" })
    )

    const error = await captureError(() => runLlmInference(MESSAGES))

    expect(error).toBeInstanceOf(TrellisAppApiError)
    expect(error).toMatchObject({
      status: 429,
      body: { error: "llm_rate_limited" }
    })
  })

  it("sends upload_ids as a top-level field separate from messages", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { text: "An X-wing." } }))

    const messages: LlmMessage[] = [{ role: "user", content: "What ship is this?" }]
    await runLlmInference(messages, ["abc-123", "def-456"])

    const [, init] = fetchMock.mock.calls[0]!
    expect(JSON.parse(init.body as string)).toEqual({
      messages,
      upload_ids: ["abc-123", "def-456"]
    })
  })

  it("sends empty upload_ids when none are passed", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { text: "ok" } }))

    await runLlmInference(MESSAGES)

    const [, init] = fetchMock.mock.calls[0]!
    expect(JSON.parse(init.body as string)).toEqual({ messages: MESSAGES, upload_ids: [] })
  })

  it("throws if TRELLIS_APP_API_SECRET is missing", async () => {
    delete process.env.TRELLIS_APP_API_SECRET
    await expect(runLlmInference(MESSAGES)).rejects.toThrow(/TRELLIS_APP_API_SECRET/)
    expect(fetchMock).not.toHaveBeenCalled()
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
