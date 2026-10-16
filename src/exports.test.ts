import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { deleteExports, exportUserUpload, writeExport } from "../src/index.js"

const BASE_URL = "https://api.example.com/trellis/apps/api/v1/"
const SECRET = "tas_mischief-managed"
const CSV = "name,points\nGryffindor,482\n"
const EXPIRES_AT = new Date("2026-11-01T00:00:00Z")

const EXPORTED_FILE = {
  path: "/hogwarts/house points.csv",
  byte_size: 28,
  content_type: "text/csv",
  sha256: "5ca1ab1e",
  written_at: "2026-10-16T17:00:00Z",
  expires_at: "2026-11-01T00:00:00Z"
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  process.env.TRELLIS_APP_API_URL = BASE_URL
  process.env.TRELLIS_APP_API_SECRET = SECRET
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => jsonResponse({ data: EXPORTED_FILE }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.TRELLIS_APP_API_URL
  delete process.env.TRELLIS_APP_API_SECRET
})

describe("writeExport", () => {
  it("PUTs the file with the given parameters", async () => {
    const result = await writeExport("/hogwarts/house points.csv", CSV, "text/csv", {
      expiresAt: EXPIRES_AT
    })

    expect(result).toEqual(EXPORTED_FILE)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [calledUrl, init] = fetchMock.mock.calls[0]!
    expect(calledUrl).toBe(
      "https://api.example.com/trellis/apps/api/v1/exports?path=%2Fhogwarts%2Fhouse+points.csv&expires_at=2026-11-01T00%3A00%3A00.000Z"
    )
    expect(init.method).toBe("PUT")
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`)
    expect(init.headers["Content-Type"]).toBe("text/csv")
    expect(init.body).toBe(CSV)
  })

  it("leaves expires_at out of the query when omitted", async () => {
    await writeExport("/hogwarts/house-points.csv", CSV, "text/csv")

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://api.example.com/trellis/apps/api/v1/exports?path=%2Fhogwarts%2Fhouse-points.csv"
    )
  })
})

describe("exportUserUpload", () => {
  it("POSTs the upload key and other parameters", async () => {
    const result = await exportUserUpload("uploads/marauders-map.png", "/maps/marauders.png", {
      expiresAt: EXPIRES_AT
    })
    await exportUserUpload("uploads/marauders-map.png", "/maps/marauders.png")

    expect(result).toEqual(EXPORTED_FILE)
    const [firstUrl, first] = fetchMock.mock.calls[0]!
    const [, second] = fetchMock.mock.calls[1]!
    expect(firstUrl).toBe("https://api.example.com/trellis/apps/api/v1/exports/adopt")
    expect(first.method).toBe("POST")
    expect(JSON.parse(first.body)).toEqual({
      s3_key: "uploads/marauders-map.png",
      path: "/maps/marauders.png",
      expires_at: "2026-11-01T00:00:00.000Z"
    })
    expect(JSON.parse(second.body)).toEqual({
      s3_key: "uploads/marauders-map.png",
      path: "/maps/marauders.png"
    })
  })
})

describe("deleteExports", () => {
  it("DELETEs one file by path or a folder by prefix, returning the deleted count", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { deleted_count: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ data: { deleted_count: 3 } }))

    const fileCount = await deleteExports({ path: "/hogwarts/house-points.csv" })
    const folderCount = await deleteExports({ prefix: "/hogwarts/" })

    expect([fileCount, folderCount]).toEqual([1, 3])
    const [fileUrl, fileInit] = fetchMock.mock.calls[0]!
    const [, folderInit] = fetchMock.mock.calls[1]!
    expect(fileUrl).toBe("https://api.example.com/trellis/apps/api/v1/exports")
    expect(fileInit.method).toBe("DELETE")
    expect(JSON.parse(fileInit.body)).toEqual({ path: "/hogwarts/house-points.csv" })
    expect(JSON.parse(folderInit.body)).toEqual({ prefix: "/hogwarts/" })
  })
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  })
}
