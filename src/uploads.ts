import { requestRaw } from "./http.js"

const UPLOADS_PATH = "uploads"

/** Result of {@link uploadFile}: an opaque id to reference the uploaded file. */
export interface UploadResult {
  upload_id: string
}

/**
 * Upload a single file for use as multimodal input to {@link runLlmInference},
 * and return an opaque `upload_id` to pass in that call's `uploadIds`.
 * Server-only.
 *
 * Accepted content types: `image/jpeg`, `image/png`, `image/gif`, `image/webp`,
 * and `application/pdf`. Each file is capped at 20MB; the combined size of all
 * files referenced in a single inference call is capped at 24MB. Upload ids are
 * scoped to the deployment that created them.
 *
 * @param data - The raw file bytes.
 * @param contentType - The file's content type (one of the accepted types).
 * @param filename - The file name; required.
 * @throws {@link TrellisAppApiError} whose `body.error` is one of:
 * `unsupported_file_type` (400), `file_too_large` (400, per-file or combined),
 * `invalid_file` (400, empty body or missing filename),
 * `invalid_upload_ids` (400). Referencing an unknown id at inference time
 * throws `upload_not_found` (400).
 *
 * @example
 * ```ts
 * const { upload_id } = await uploadFile(bytes, "application/pdf", "report.pdf")
 * const { text } = await runLlmInference(
 *   [{ role: "user", content: "Summarize this." }],
 *   [upload_id]
 * )
 * ```
 */
export async function uploadFile(
  data: Uint8Array,
  contentType: string,
  filename: string
): Promise<UploadResult> {
  const path = `${UPLOADS_PATH}?filename=${encodeURIComponent(filename)}`
  return requestRaw<UploadResult>(path, data, contentType)
}
