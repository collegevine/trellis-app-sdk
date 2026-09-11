import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"
import { withAuth } from "../auth/rrv7-middleware.js"
import type { FetchHandler } from "../lambda.js"
import { withUploadTickets } from "./endpoint.js"
import { UPLOAD_TICKET_PATH } from "./protocol.js"

const ORIGIN = "https://x-wing.dagobah.apps.collegevine.ai"
const PREFIX = "production/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/"
const MAX_BYTES = 20971520

let app: FetchHandler
let appHandler: Mock<FetchHandler>

beforeEach(() => {
  appHandler = vi.fn(async () => new Response("app page", { status: 200 }))
  app = withUploadTickets(appHandler)

  process.env.TRELLIS_APP_UPLOADS_BUCKET = "cv-apps-user-uploads"
  process.env.TRELLIS_APP_UPLOADS_PREFIX = PREFIX
  process.env.TRELLIS_APP_UPLOADS_MAX_BYTES = String(MAX_BYTES)
  process.env.AWS_REGION = "us-east-1"
  process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE"
  process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  delete process.env.AWS_PROFILE
})

afterEach(() => {
  delete process.env.TRELLIS_APP_UPLOADS_BUCKET
  delete process.env.TRELLIS_APP_UPLOADS_PREFIX
  delete process.env.TRELLIS_APP_UPLOADS_MAX_BYTES
  delete process.env.AWS_ACCESS_KEY_ID
  delete process.env.AWS_SECRET_ACCESS_KEY
  delete process.env.TRELLIS_APP_AUTH_MODE
})

function postTicket(body: unknown): Promise<Response> {
  return app(
    new Request(`${ORIGIN}${UPLOAD_TICKET_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body)
    })
  )
}

describe("withUploadTickets", () => {
  it("answers a valid claim with a presigned PUT and leaves the app handler alone", async () => {
    const response = await postTicket({
      filename: "receipt.pdf",
      contentType: "application/pdf",
      size: 2_800_000
    })

    expect(response.status).toBe(200)
    const ticket = (await response.json()) as { s3Key: string; url: string }
    expect(ticket.s3Key.startsWith(PREFIX)).toBe(true)
    expect(new URL(ticket.url).searchParams.get("X-Amz-Signature")).toBeTruthy()
    expect(appHandler).not.toHaveBeenCalled()
  })

  it("ignores a client-supplied key: the prefix is not negotiable", async () => {
    const response = await postTicket({
      filename: "receipt.pdf",
      contentType: "application/pdf",
      size: 10,
      s3Key: "production/other-school/other-app/owned.pdf",
      key: "production/other-school/other-app/owned.pdf"
    })

    const { s3Key } = (await response.json()) as { s3Key: string }
    expect(s3Key.startsWith(PREFIX)).toBe(true)
  })

  it("refuses a file above the deployment's cap", async () => {
    const response = await postTicket({
      filename: "big.zip",
      contentType: "application/zip",
      size: MAX_BYTES + 1
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "file_too_large" })
  })

  it("accepts a file exactly at the cap", async () => {
    const response = await postTicket({
      filename: "exact.zip",
      contentType: "application/zip",
      size: MAX_BYTES
    })

    expect(response.status).toBe(200)
  })

  it("refuses a missing or parameterized content type", async () => {
    expect(
      await (await postTicket({ filename: "a.txt", size: 5 })).json()
    ).toEqual({ error: "unsupported_file_type" })
    expect(
      await (
        await postTicket({
          filename: "a.txt",
          contentType: "text/plain; charset=utf-8",
          size: 5
        })
      ).json()
    ).toEqual({ error: "unsupported_file_type" })
  })

  it("refuses a blank filename or a size that is not a positive integer", async () => {
    const type = "text/plain"
    expect(
      await (await postTicket({ filename: "   ", contentType: type, size: 5 })).json()
    ).toEqual({ error: "invalid_file" })
    expect(
      await (await postTicket({ filename: "a.txt", contentType: type, size: 0 })).json()
    ).toEqual({ error: "invalid_file" })
    expect(
      await (await postTicket({ filename: "a.txt", contentType: type, size: 1.5 })).json()
    ).toEqual({ error: "invalid_file" })
    expect(
      await (await postTicket({ filename: "a.txt", contentType: type, size: "5" })).json()
    ).toEqual({ error: "invalid_file" })
  })

  it("refuses a body that is not a JSON object", async () => {
    expect(await (await postTicket("not json at all")).json()).toEqual({
      error: "invalid_request"
    })
  })

  it("rejects methods other than POST on the reserved path", async () => {
    const response = await app(new Request(`${ORIGIN}${UPLOAD_TICKET_PATH}`))

    expect(response.status).toBe(405)
    expect(response.headers.get("Allow")).toBe("POST")
    expect(appHandler).not.toHaveBeenCalled()
  })

  it("passes every other path through to the app", async () => {
    const response = await app(new Request(`${ORIGIN}/dashboard`))

    expect(await response.text()).toBe("app page")
    expect(appHandler).toHaveBeenCalledOnce()
  })

  // The endpoint carries no auth logic of its own; it is mounted inside the
  // auth gate, which is what keeps an authenticated-mode app from handing out
  // upload URLs to anonymous callers.
  it("is unreachable without a session in authenticated mode", async () => {
    process.env.TRELLIS_APP_AUTH_MODE = "authenticated"
    process.env.TRELLIS_APP_AUTHORIZE_URL = `https://collegevine.com/authorize?app_id=1`
    app = withAuth(withUploadTickets(appHandler))

    const response = await postTicket({
      filename: "receipt.pdf",
      contentType: "application/pdf",
      size: 10
    })

    expect(response.status).toBe(302)
    expect(response.headers.get("Location")).toContain("collegevine.com/authorize")
  })
})
