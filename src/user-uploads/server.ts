import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import {
  ENV_AWS_REGION,
  ENV_UPLOADS_BUCKET,
  ENV_UPLOADS_PREFIX,
  readEnv
} from "../env.js"
import { request } from "../http.js"
import type { UploadTicket, UploadTicketRequest } from "./protocol.js"

const READ_URL_PATH = "uploads/read-url"

const ADOPT_PATH = "uploads/adopt"

const UPLOAD_URL_EXPIRES_IN_SECONDS = 15 * 60

const FILENAME_MAX_LENGTH = 100
const FILENAME_FALLBACK = "file"
const UNSAFE_FILENAME_CHARS = /[^A-Za-z0-9._-]+/g

let cachedClient: S3Client | null = null

// Mint a presigned PUT for one file. `size` and `contentType` are signed into
// the URL, so S3 rejects a body that does not match what the browser declared
// here - that's how we enforce the size cap. The key is derived server-side and
// never accepted from the client.
export async function presignUpload(
  ticket: UploadTicketRequest
): Promise<UploadTicket> {
  const s3Key =
    `${readEnv(ENV_UPLOADS_PREFIX)}${crypto.randomUUID()}` +
    `/${sanitizeFilename(ticket.filename)}`
  cachedClient ??= new S3Client({ region: readEnv(ENV_AWS_REGION) })

  const url = await getSignedUrl(
    cachedClient,
    new PutObjectCommand({
      Bucket: readEnv(ENV_UPLOADS_BUCKET),
      Key: s3Key,
      ContentType: ticket.contentType,
      ContentLength: ticket.size
    }),
    {
      expiresIn: UPLOAD_URL_EXPIRES_IN_SECONDS,

      // Declare these headers as part of the signature, which S3 will then
      // verify, so the browser can't pull bait-and-switch on us.
      signableHeaders: new Set(["content-length", "content-type"])
    }
  )

  return { s3Key, url }
}

// The filename is user input that becomes part of an S3 key, so we sanitize it
// conservatively.
function sanitizeFilename(filename: string): string {
  const basename = filename.split(/[/\\]/).pop() ?? ""
  const safe = basename
    .replace(UNSAFE_FILENAME_CHARS, "_")
    .replace(/^[._]+/, "")
    .slice(0, FILENAME_MAX_LENGTH)
  return safe || FILENAME_FALLBACK
}

/**
 * A short-lived URL the browser can use to read a file that was uploaded with
 * `uploadFile` from `@collegevine/trellis-app-sdk/client`. Server-only: call
 * it from a loader for the files the page is about to render, and pass the
 * resulting URLs down as props.
 *
 * The URL expires in five minutes, so treat it as per-render output rather
 * than something to store. Keys are only valid for the app that created them.
 *
 * @param s3Key - The key `uploadFile` returned for the file.
 * @throws {@link TrellisAppApiError} whose `body.error` is one of:
 * `forbidden_key` (403, the key belongs to another app),
 * `invalid_file` (400, no key supplied).
 *
 * @example
 * ```ts
 * export async function loader() {
 *   const rows = await db.query("select id, s3_key from receipts")
 *   return {
 *     receipts: await Promise.all(
 *       rows.map(async (r) => ({ id: r.id, url: await fileUrl(r.s3_key) }))
 *     )
 *   }
 * }
 * ```
 */
export async function fileUrl(s3Key: string): Promise<string> {
  const { url } = await request<{ url: string; expires_in: number }>(
    READ_URL_PATH,
    { method: "POST", body: { s3_key: s3Key } }
  )
  return url
}

/**
 * Make a user-uploaded file (i.e. uploaded via `uploadFile` from
 * `@collegevine/trellis-app-sdk/client`) usable as multimodal input to
 * {@link runLlmInference}, and return the `upload_id` to pass in that call's
 * `uploadIds`. Server-only.
 *
 * The platform copies the bytes out of storage on its own side. The stored file
 * stays where it is, so `fileUrl` keeps working for it afterwards.
 *
 * Accepted content types are the ones {@link runLlmInference} takes:
 * `image/jpeg`, `image/png`, `image/gif`, `image/webp`, and `application/pdf`.
 * The type is determined from the file's own bytes, not from what the browser
 * declared at upload time, so an mp4 renamed to `.png` is refused here.
 *
 * @param s3Key - The key `uploadFile` returned for the file.
 * @param filename - Name to carry into inference; required, and passed to the
 * model as the document title for PDFs.
 * @throws {@link TrellisAppApiError} whose `body.error` is one of:
 * `forbidden_key` (403, the key belongs to another app), `file_not_found` (404,
 * nothing stored under that key), `file_too_large` (400, over the 20MB cap),
 * `unsupported_file_type` (400, the bytes are not an accepted type),
 * `invalid_file` (400, no filename supplied).
 *
 * @example
 * ```ts
 * export async function action({ request }: ActionFunctionArgs) {
 *   const { s3Key, filename } = await request.json()
 *   const uploadId = await adoptFile(s3Key, filename)
 *   const { text } = await runLlmInference(
 *     [{ role: "user", content: "Summarize this." }],
 *     [uploadId]
 *   )
 *   return { text }
 * }
 * ```
 */
export async function adoptFile(
  s3Key: string,
  filename: string
): Promise<string> {
  const { upload_id } = await request<{ upload_id: string }>(ADOPT_PATH, {
    method: "POST",
    body: { s3_key: s3Key, filename }
  })
  return upload_id
}
