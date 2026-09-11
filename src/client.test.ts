import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UploadError, uploadFile } from "./client.js"
import { UPLOAD_TICKET_PATH } from "./user-uploads/protocol.js"

const PRESIGNED_URL = "https://cv-apps-user-uploads.s3.us-east-1.amazonaws.com/production/s/a/uid/receipt.pdf?X-Amz-Signature=abc"
const S3_KEY = "production/s/a/uid/receipt.pdf"

// Stand-in for the browser's XMLHttpRequest. Nothing happens until a test
// calls one of the settle helpers, so each test drives the transfer itself.
class FakeXhr {
  static last: FakeXhr | undefined

  status = 0
  responseText = ""
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  upload = { onprogress: null as ((e: { loaded: number; total: number }) => void) | null }

  method = ""
  url = ""
  headers: Record<string, string> = {}
  body: unknown = null
  aborted = false

  constructor() {
    FakeXhr.last = this
  }

  open(method: string, url: string): void {
    this.method = method
    this.url = url
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value
  }

  send(body: unknown): void {
    this.body = body
  }

  abort(): void {
    this.aborted = true
    this.onabort?.()
  }

  succeed(status = 200): void {
    this.status = status
    this.onload?.()
  }

  fail(status: number, responseText: string): void {
    this.status = status
    this.responseText = responseText
    this.onload?.()
  }
}

const fetchMock = vi.fn()

function ticketResponse(): Response {
  return new Response(JSON.stringify({ s3Key: S3_KEY, url: PRESIGNED_URL }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  })
}

function file(name = "receipt.pdf", type = "application/pdf"): File {
  return new File([new Uint8Array(2048)], name, { type })
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  vi.stubGlobal("XMLHttpRequest", FakeXhr)
  fetchMock.mockReset()
  FakeXhr.last = undefined
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("uploadFile", () => {
  it("claims a ticket from the app's server, then PUTs the bytes to the URL it was given", async () => {
    fetchMock.mockResolvedValue(ticketResponse())

    const uploaded = uploadFile(file())
    await vi.waitUntil(() => FakeXhr.last)
    FakeXhr.last!.succeed()

    expect(await uploaded).toEqual({ s3Key: S3_KEY })

    const [ticketUrl, init] = fetchMock.mock.calls[0]!
    expect(ticketUrl).toBe(UPLOAD_TICKET_PATH)
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body)).toEqual({
      filename: "receipt.pdf",
      contentType: "application/pdf",
      size: 2048
    })

    const xhr = FakeXhr.last!
    expect(xhr.method).toBe("PUT")
    expect(xhr.url).toBe(PRESIGNED_URL)
    // S3 verifies this against the signature, so it has to be the same value
    // the ticket was minted for.
    expect(xhr.headers["Content-Type"]).toBe("application/pdf")
    expect(xhr.body).toBeInstanceOf(File)
  })

  it("declares an opaque content type for a file the browser could not classify", async () => {
    fetchMock.mockResolvedValue(ticketResponse())

    const uploaded = uploadFile(file("mystery.bin", ""))
    await vi.waitUntil(() => FakeXhr.last)
    FakeXhr.last!.succeed()
    await uploaded

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).contentType).toBe(
      "application/octet-stream"
    )
    expect(FakeXhr.last!.headers["Content-Type"]).toBe("application/octet-stream")
  })

  it("reports progress as bytes reach storage", async () => {
    fetchMock.mockResolvedValue(ticketResponse())
    const onProgress = vi.fn()

    const uploaded = uploadFile(file(), { onProgress })
    await vi.waitUntil(() => FakeXhr.last)
    const xhr = FakeXhr.last!
    xhr.upload.onprogress!({ loaded: 512, total: 2048 })
    xhr.upload.onprogress!({ loaded: 2048, total: 2048 })
    xhr.succeed()
    await uploaded

    expect(onProgress.mock.calls).toEqual([
      [{ loaded: 512, total: 2048 }],
      [{ loaded: 2048, total: 2048 }]
    ])
  })

  it("falls back to the file's own size when a progress event has no total", async () => {
    fetchMock.mockResolvedValue(ticketResponse())
    const onProgress = vi.fn()

    const uploaded = uploadFile(file(), { onProgress })
    await vi.waitUntil(() => FakeXhr.last)
    FakeXhr.last!.upload.onprogress!({ loaded: 512, total: 0 })
    FakeXhr.last!.succeed()
    await uploaded

    expect(onProgress).toHaveBeenCalledWith({ loaded: 512, total: 2048 })
  })

  it("surfaces the server's refusal without touching storage", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "file_too_large" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      })
    )

    const error = await uploadFile(file()).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(UploadError)
    expect(error).toMatchObject({ status: 400, body: { error: "file_too_large" } })
    expect(FakeXhr.last).toBeUndefined()
  })

  it("surfaces a storage rejection with S3's response", async () => {
    fetchMock.mockResolvedValue(ticketResponse())

    const uploaded = uploadFile(file())
    await vi.waitUntil(() => FakeXhr.last)
    FakeXhr.last!.fail(403, "<Error><Code>SignatureDoesNotMatch</Code></Error>")

    const error = await uploaded.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(UploadError)
    expect(error).toMatchObject({
      status: 403,
      body: "<Error><Code>SignatureDoesNotMatch</Code></Error>"
    })
  })

  it("surfaces a network failure", async () => {
    fetchMock.mockResolvedValue(ticketResponse())

    const uploaded = uploadFile(file())
    await vi.waitUntil(() => FakeXhr.last)
    FakeXhr.last!.onerror!()

    await expect(uploaded).rejects.toMatchObject({
      name: "UploadError",
      status: 0
    })
  })

  it("aborts the transfer and rejects with the signal's reason", async () => {
    fetchMock.mockResolvedValue(ticketResponse())
    const controller = new AbortController()

    const uploaded = uploadFile(file(), { signal: controller.signal })
    await vi.waitUntil(() => FakeXhr.last)
    controller.abort(new Error("user cancelled"))

    await expect(uploaded).rejects.toThrow("user cancelled")
    expect(FakeXhr.last!.aborted).toBe(true)
  })
})
