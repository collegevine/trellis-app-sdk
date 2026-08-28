import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { queryOntology, TrellisAppApiError } from "../src/index.js"

const BASE_URL = "https://api.example.com/trellis/apps/api/v1/"
const SECRET = "tas_speak-friend-and-enter"
const DATA_SCHEMA = "ontology_v2"
const SQL = "SELECT id, name FROM students"

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

describe("queryOntology", () => {
  it("POSTs the sql and data schema as JSON with bearer auth and unwraps the envelope", async () => {
    const ontologyBody = {
      columns: [
        { name: "id", type: "BIGINT" },
        { name: "name", type: "STRING" }
      ],
      rows: [["1", "Paul Atreides"]],
      truncated: true
    }
    fetchMock.mockResolvedValue(jsonResponse(200, { data: ontologyBody }))

    const result = await queryOntology({ dataSchema: DATA_SCHEMA, sql: SQL })

    expect(result).toEqual(ontologyBody)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [calledUrl, init] = fetchMock.mock.calls[0]!
    expect(calledUrl).toBe(
      "https://api.example.com/trellis/apps/api/v1/ontology/query"
    )
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`)
    expect(init.headers["Content-Type"]).toBe("application/json")
    expect(JSON.parse(init.body as string)).toEqual({
      sql: SQL,
      data_schema: DATA_SCHEMA
    })
  })

  it("sends max_rows only when given", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(200, { data: { columns: [], rows: [], truncated: false } })
      )
    )

    await queryOntology({ dataSchema: DATA_SCHEMA, sql: SQL, maxRows: 500 })
    await queryOntology({ dataSchema: DATA_SCHEMA, sql: SQL })

    const [, withCap] = fetchMock.mock.calls[0]!
    const [, withoutCap] = fetchMock.mock.calls[1]!
    expect(JSON.parse(withCap.body as string)).toEqual({
      sql: SQL,
      data_schema: DATA_SCHEMA,
      max_rows: 500
    })
    expect(JSON.parse(withoutCap.body as string)).not.toHaveProperty("max_rows")
  })

  it("throws TrellisAppApiError carrying status, body, and the upstream code on a governed-access failure", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: "ontology_forbidden",
        message: "this data is scoped to caller attributes the session does not carry",
        details: { code: "CALLER_ATTRS_REQUIRED" }
      })
    )

    const error = await captureError(() =>
      queryOntology({ dataSchema: DATA_SCHEMA, sql: SQL })
    )

    expect(error).toBeInstanceOf(TrellisAppApiError)
    expect(error).toMatchObject({
      status: 403,
      body: {
        error: "ontology_forbidden",
        details: { code: "CALLER_ATTRS_REQUIRED" }
      }
    })
  })

  it("throws TrellisAppApiError when ontology_not_configured comes back as 422", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, { error: "ontology_not_configured", message: "..." })
    )

    const error = await captureError(() =>
      queryOntology({ dataSchema: DATA_SCHEMA, sql: SQL })
    )

    expect(error).toBeInstanceOf(TrellisAppApiError)
    expect((error as TrellisAppApiError).status).toBe(422)
    expect((error as TrellisAppApiError).body).toMatchObject({
      error: "ontology_not_configured"
    })
  })

  it("throws TrellisAppApiError when a 2xx response is not JSON", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>this is fine</html>", { status: 200 })
    )

    const error = await captureError(() =>
      queryOntology({ dataSchema: DATA_SCHEMA, sql: SQL })
    )

    expect(error).toBeInstanceOf(TrellisAppApiError)
    expect((error as TrellisAppApiError).status).toBe(200)
  })

  it("throws if TRELLIS_APP_API_URL is missing, without calling fetch", async () => {
    delete process.env.TRELLIS_APP_API_URL
    await expect(
      queryOntology({ dataSchema: DATA_SCHEMA, sql: SQL })
    ).rejects.toThrow(/TRELLIS_APP_API_URL/)
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
