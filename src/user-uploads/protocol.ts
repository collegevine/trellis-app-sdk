// Wire contract between the browser helper (`../client.ts`) and the reserved
// endpoint the Lambda adapter serves (`./endpoint.js`). Both sides of this
// protocol ship in the same SDK version, so it is internal: app code never
// constructs these shapes by hand, and nothing here is re-exported from the
// package root.
//
// This module must stay dependency-free — the browser bundle imports it.

// The client-side `uploadFile` in `../client.ts` function calls this route, and
// the server-side handler in `./endpoint.ts` responds with a pre-signed S3 URL
// to upload the file.
export const UPLOAD_TICKET_PATH = "/_trellis/uploads"

/** What the browser tells the app's server about the file it wants to send. */
export interface UploadTicketRequest {
  filename: string
  contentType: string
  size: number
}

/**
 * The server's answer: where to PUT the bytes, and the key the app will use to
 * refer to the file afterwards. The URL is single-use and short-lived.
 */
export interface UploadTicket {
  s3Key: string
  url: string
}

/**
 * Why a ticket was refused. Returned as `{ error: <code> }` with status 400.
 *
 * - `invalid_file` — no filename, or a size that is not a positive integer.
 * - `file_too_large` — size above `TRELLIS_APP_UPLOADS_MAX_BYTES`.
 * - `unsupported_file_type` — missing or malformed `contentType`.
 * - `invalid_request` — body is not JSON, or not an object.
 */
export type UploadTicketErrorCode =
  | "invalid_file"
  | "file_too_large"
  | "unsupported_file_type"
  | "invalid_request"
