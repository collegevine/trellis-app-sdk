import { ENV_UPLOADS_MAX_BYTES, readEnv } from "../env.js"
import type { FetchHandler } from "../lambda.js"
import { presignUpload } from "./server.js"
import {
  UPLOAD_TICKET_PATH,
  type UploadTicketErrorCode,
  type UploadTicketRequest
} from "./protocol.js"

// type/subtype with no parameters. The signed URL pins one exact string, so a
// `; charset=` the browser might normalize differently would break the
// signature rather than the upload's correctness; refusing it here gives a
// readable error instead.
const CONTENT_TYPE_PATTERN = /^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+$/i

// Handles the `/_trellis/uploads` path, taking an upload ticket request from
// the client (see `uploadFile` in `@collegevine/trellis-app-sdk/client`) and
// returning a pre-signed S3 PUT URL for the browser to upload to.
export function withUploadTickets(handler: FetchHandler): FetchHandler {
  return async (request) => {
    if (new URL(request.url).pathname !== UPLOAD_TICKET_PATH) {
      return handler(request)
    }
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { Allow: "POST" } })
    }

    const body: unknown = await request.json().catch(() => null)
    const ticket = validate(body)
    if (typeof ticket === "string") {
      return Response.json({ error: ticket }, { status: 400 })
    }

    return Response.json(await presignUpload(ticket))
  }
}

// Returns the validated claim, or the code explaining why it was refused.
function validate(body: unknown): UploadTicketRequest | UploadTicketErrorCode {
  if (typeof body !== "object" || body === null) return "invalid_request"

  const { filename, contentType, size } = body as Record<string, unknown>

  if (typeof filename !== "string" || filename.trim() === "") {
    return "invalid_file"
  }
  if (typeof contentType !== "string" || !CONTENT_TYPE_PATTERN.test(contentType)) {
    return "unsupported_file_type"
  }
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) {
    return "invalid_file"
  }
  if (size > Number(readEnv(ENV_UPLOADS_MAX_BYTES))) return "file_too_large"

  return { filename, contentType, size }
}
