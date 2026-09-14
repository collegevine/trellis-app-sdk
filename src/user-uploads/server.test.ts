import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fileUrl, presignUpload } from "./server.js"

const API_URL = "https://api.example.com/trellis/apps/api/v1/"
const SECRET = "tas_use-the-force-luke"
const BUCKET = "cv-apps-user-uploads"
const PREFIX = "production/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/"

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
  process.env.TRELLIS_APP_API_URL = API_URL
  process.env.TRELLIS_APP_API_SECRET = SECRET
  process.env.TRELLIS_APP_UPLOADS_BUCKET = BUCKET
  process.env.TRELLIS_APP_UPLOADS_PREFIX = PREFIX
  process.env.AWS_REGION = "us-east-1"
  process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE"
  process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  // A developer's AWS_PROFILE takes precedence over static env credentials in
  // the SDK's credential chain, and would send these tests to SSO.
  delete process.env.AWS_PROFILE
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.TRELLIS_APP_API_URL
  delete process.env.TRELLIS_APP_API_SECRET
  delete process.env.TRELLIS_APP_UPLOADS_BUCKET
  delete process.env.TRELLIS_APP_UPLOADS_PREFIX
  delete process.env.AWS_ACCESS_KEY_ID
  delete process.env.AWS_SECRET_ACCESS_KEY
})

describe("presignUpload", () => {
  it("signs a PUT for a key under this app's prefix, holding S3 to the declared size and type", async () => {
    const { s3Key, url } = await presignUpload({
      filename: "receipt.pdf",
      contentType: "application/pdf",
      size: 1024
    })

    expect(s3Key.startsWith(PREFIX)).toBe(true)
    expect(s3Key).toMatch(
      new RegExp(`^${PREFIX}[0-9a-f-]{36}/receipt\\.pdf$`)
    )

    const signed = new URL(url)
    expect(signed.host).toBe(`${BUCKET}.s3.us-east-1.amazonaws.com`)
    expect(signed.pathname).toBe(`/${s3Key}`)
    // Without content-length among the signed headers, a browser could reuse
    // the URL to push a body of any size.
    expect(signed.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;content-type;host"
    )
    expect(signed.searchParams.get("X-Amz-Expires")).toBe("900")
    expect(signed.searchParams.get("X-Amz-Signature")).toBeTruthy()
  })

  it("derives a fresh key per call so two uploads of one filename cannot collide", async () => {
    const first = await presignUpload({
      filename: "receipt.pdf",
      contentType: "application/pdf",
      size: 1
    })
    const second = await presignUpload({
      filename: "receipt.pdf",
      contentType: "application/pdf",
      size: 1
    })

    expect(first.s3Key).not.toBe(second.s3Key)
  })

  it("reduces a hostile filename to a leaf inside the prefix", async () => {
    const { s3Key } = await presignUpload({
      filename: "../../etc/pass wd?x=1",
      contentType: "text/plain",
      size: 4
    })

    expect(s3Key.startsWith(PREFIX)).toBe(true)
    expect(s3Key.endsWith("/pass_wd_x_1")).toBe(true)
  })

  it("falls back to a placeholder when a filename sanitizes to nothing", async () => {
    const { s3Key } = await presignUpload({
      filename: "...",
      contentType: "text/plain",
      size: 4
    })

    expect(s3Key.endsWith("/file")).toBe(true)
  })
})

describe("fileUrl", () => {
  it("asks the platform to sign a read of the key and returns the URL", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ data: { url: "https://s3.example/x?sig=1", expires_in: 300 } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    )

    const url = await fileUrl(`${PREFIX}abc/receipt.pdf`)

    expect(url).toBe("https://s3.example/x?sig=1")
    const [calledUrl, init] = fetchMock.mock.calls[0]!
    expect(calledUrl).toBe(
      "https://api.example.com/trellis/apps/api/v1/uploads/read-url"
    )
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`)
    expect(JSON.parse(init.body)).toEqual({ s3_key: `${PREFIX}abc/receipt.pdf` })
  })

  it("surfaces a refused key as TrellisAppApiError", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "forbidden_key" }), {
        status: 403,
        headers: { "Content-Type": "application/json" }
      })
    )

    await expect(fileUrl("production/other-school/other-app/x")).rejects.toMatchObject({
      name: "TrellisAppApiError",
      status: 403,
      body: { error: "forbidden_key" }
    })
  })
})
