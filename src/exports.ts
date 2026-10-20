import { request, requestRaw } from "./http.js"

const EXPORTS_PATH = "exports"
const EXPORT_USER_UPLOAD_PATH = "exports/adopt"

/**
 * A file the app has exported, as returned by {@link writeExport} and
 * {@link exportUserUpload}.
 */
export interface ExportedFile {
  /** The file's path, NFC-normalized. */
  path: string
  byte_size: number
  /** The content type staff download the file with. */
  content_type: string
  /** Hex-encoded SHA-256 of the file's bytes. */
  sha256: string
  /** ISO 8601 time of the write. */
  written_at: string
  /** ISO 8601 time when the platform deletes the file. */
  expires_at: string
}

/** Options for {@link writeExport} and {@link exportUserUpload}. */
export interface ExportOptions {
  /**
   * When the platform deletes the file. Defaults to 30 days after the write,
   * maximum 365 days.
   */
  expiresAt?: Date
}

/**
 * What {@link deleteExports} deletes: one file by its `path`, or every file in
 * a folder by its `prefix`, which ends in `/`.
 */
export type ExportTarget =
  | { path: string; prefix?: never }
  | { prefix: string; path?: never }

/**
 * Export a file at `path` for the school to download later from the platform.
 * Server-side only. Writing to a path that already holds a file replaces the
 * file and its expiration.
 *
 * Exports are write-only: the app cannot list or read them back.
 *
 * Paths start with `/`, have no empty segments, no `.` or `..` segments, no
 * control characters, and are at most 900 bytes. They are case-sensitive and
 * NFC-normalized. Folders are implicit: `/reports/q3.csv` is in the `/reports/`
 * folder, which can be deleted via {@link deleteExports} by prefix.
 *
 * Each file is capped at 20MB. To export a file that a user uploaded from the
 * browser, use {@link exportUserUpload}, so it doesn't have to pass through the
 * app code.
 *
 * @param path - Where to put the file, e.g. `/reports/2026-q3.csv`.
 * @param body - The file's bytes. A string is sent as UTF-8.
 * @param contentType - The content type staff download the file with.
 * @throws {@link TrellisAppApiError} whose `body.error` is one of: `invalid_path` (400),
 * `invalid_expires_at` (400, not after the write, or more than 365 days after
 * it), `file_too_large` (400, over 20MB).
 *
 * @example
 * ```ts
 * const csv = rows.map((r) => `${r.name},${r.gpa}`).join("\n")
 * await writeExport("/reports/2026-q3.csv", csv, "text/csv", {
 *   expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
 * })
 * ```
 */
export async function writeExport(
  path: string,
  body: Uint8Array | string,
  contentType: string,
  options: ExportOptions = {}
): Promise<ExportedFile> {
  const query = new URLSearchParams({
    path,
    ...(options.expiresAt && { expires_at: options.expiresAt.toISOString() })
  })
  return requestRaw<ExportedFile>(`${EXPORTS_PATH}?${query}`, body, contentType, "PUT")
}

/**
 * Export a file that a user uploaded from their browser via `uploadFile` from
 * `@collegevine/trellis-app-sdk/client`. Server-side only.
 *
 * The uploaded file is copied to the export storage, and the original copy
 * stays where it was. Paths, replacement and expiration work as in
 * {@link writeExport}.
 *
 * @param s3Key - The key `uploadFile` returned for the file.
 * @param path - Where to put the file, e.g. `/transcripts/jimmy.pdf`.
 * @throws {@link TrellisAppApiError} whose `body.error` is one of:
 * `forbidden_key` (403, the key belongs to another app), `file_not_found` (404,
 * nothing stored under that key), `bad_request` (400, no key supplied),
 * `invalid_path` (400), `invalid_expires_at` (400, not after the write, or more
 * than 365 days after it), `file_too_large` (400, over 5GB).
 *
 * @example
 * ```ts
 * export async function action({ request }: ActionFunctionArgs) {
 *   const { s3Key, studentId } = await request.json()
 *   await exportUserUpload(s3Key, `/transcripts/${studentId}.pdf`)
 *   return { ok: true }
 * }
 * ```
 */
export async function exportUserUpload(
  s3Key: string,
  path: string,
  options: ExportOptions = {}
): Promise<ExportedFile> {
  return request<ExportedFile>(EXPORT_USER_UPLOAD_PATH, {
    method: "POST",
    body: { s3_key: s3Key, path, expires_at: options.expiresAt?.toISOString() }
  })
}

/**
 * Delete one exported file, or every exported file in a folder, and return how
 * many files were deleted. Server-side only. Deleting a non-existent file does
 * not fail and returns 0.
 *
 * @param target - `{ path }` for one file, or `{ prefix }` for a folder, e.g.
 * `{ prefix: "/reports/" }`. The prefix `/` deletes all of the app's exports.
 * `path` and `prefix` cannot be both present.
 * @throws {@link TrellisAppApiError} whose `body.error` is one of:
 * `invalid_path` (400), `invalid_prefix` (400, including one that does not end
 * in `/`).
 *
 * @example
 * ```ts
 * await deleteExports({ path: "/reports/2026-q3.csv" })
 * await deleteExports({ prefix: "/reports/" })
 * ```
 */
export async function deleteExports(target: ExportTarget): Promise<number> {
  const { deleted_count } = await request<{ deleted_count: number }>(EXPORTS_PATH, {
    method: "DELETE",
    body: target
  })
  return deleted_count
}
