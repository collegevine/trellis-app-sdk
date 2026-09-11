import {
  UPLOAD_TICKET_PATH,
  type UploadTicket,
  type UploadTicketRequest
} from "./user-uploads/protocol.js"

/** Progress of an in-flight {@link uploadFile}, in bytes. */
export interface UploadProgress {
  loaded: number
  total: number
}

/** Options for {@link uploadFile}. */
export interface UploadOptions {
  /** Called as bytes reach S3. Fires on every network progress event. */
  onProgress?: (progress: UploadProgress) => void
  /** Aborts the upload. The returned promise rejects with the abort reason. */
  signal?: AbortSignal
}

/** Result of {@link uploadFile}. */
export interface UploadedFile {
  /**
   * The file's S3 key. Opaque, unique per upload, and the only handle to the
   * file: store it, and pass it to `fileUrl` on the server to render the file
   * back to a user.
   */
  s3Key: string
}

/**
 * Send a file straight from the browser to storage, bypassing the app server
 * entirely. Two steps: the app's server mints a presigned URL for this exact
 * file, then the bytes go to S3 in a single PUT.
 *
 * Use this for any user-supplied file instead of posting bytes to one of the
 * app's own actions. Posting to app's own action fails above roughly 4.5MB,
 * because the request has to fit in a Lambda invocation payload.
 *
 * @param file - The file to upload, typically from an `<input type="file">`.
 * @param options - Progress callback and abort signal.
 * @returns The file's `s3Key`, to persist and later resolve with `fileUrl`.
 * @throws {@link UploadError} when the server refuses the file (`body.error` is
 * `file_too_large`, `unsupported_file_type`, or `invalid_file`), when S3
 * rejects the PUT, or when the network fails.
 *
 * @example
 * ```tsx
 * const { s3Key } = await uploadFile(input.files[0], {
 *   onProgress: ({ loaded, total }) => setPercent((loaded / total) * 100)
 * })
 * await fetch("/receipts", { method: "POST", body: JSON.stringify({ s3Key }) })
 * ```
 */
export async function uploadFile(
  file: File,
  options: UploadOptions = {}
): Promise<UploadedFile> {
  const claim: UploadTicketRequest = {
    filename: file.name,
    contentType: file.type || "application/octet-stream",
    size: file.size
  }

  const response = await fetch(UPLOAD_TICKET_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(claim),
    signal: options.signal
  })
  if (!response.ok) {
    throw new UploadError(
      `Upload refused (${response.status})`,
      response.status,
      await response.json().catch(() => null)
    )
  }

  const ticket = (await response.json()) as UploadTicket
  await put(ticket.url, file, claim.contentType, options)
  return { s3Key: ticket.s3Key }
}

/**
 * Thrown by {@link uploadFile}. `status` is the HTTP status that failed and
 * `body` the parsed error payload, `{ error: "<code>" }`, when the app's
 * server produced one.
 */
export class UploadError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = "UploadError"
    this.status = status
    this.body = body
  }
}

interface ProgressEvent {
  loaded: number
  total: number
}

interface UploadXhr {
  status: number
  responseText: string
  onload: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
  upload: { onprogress: ((event: ProgressEvent) => void) | null }
  open(method: string, url: string): void
  setRequestHeader(name: string, value: string): void
  send(body: File): void
  abort(): void
}

// Using XMLHttpRequest (not fetch) for uploads, because upload progress events
// are still XHR-only except in Chromium.
declare const XMLHttpRequest: new () => UploadXhr

function put(
  url: string,
  file: File,
  contentType: string,
  { onProgress, signal }: UploadOptions
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const xhr = new XMLHttpRequest()

  xhr.open("PUT", url)
  xhr.setRequestHeader("Content-Type", contentType)

  if (onProgress) {
    xhr.upload.onprogress = (event) =>
      onProgress({ loaded: event.loaded, total: event.total || file.size })
  }

  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) return resolve()
    reject(
      new UploadError(
        `Storage rejected the upload (${xhr.status})`,
        xhr.status,
        xhr.responseText // in S3 response this will be an XML document, so we don't parse it
      )
    )
  }
  xhr.onerror = () =>
    reject(new UploadError("Upload failed to reach storage", 0, null))
  xhr.onabort = () => reject(signal?.reason ?? new Error("Upload aborted"))

  signal?.addEventListener("abort", () => xhr.abort(), { once: true })
  xhr.send(file)

  return promise
}
