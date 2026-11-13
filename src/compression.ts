// CloudFront in front of the apps has caching turned off, which also turns
// off its compression. So the app compresses its own responses here.

import { brotliCompressSync, constants, gzipSync } from "node:zlib"

export type ContentEncoding = "br" | "gzip"

// Smaller bodies barely shrink. CloudFront uses the same cutoff.
export const MIN_COMPRESSIBLE_BYTES = 1000

// On a 219 KB JS bundle, quality 5 took 2.6 ms and quality 11 took 190 ms,
// for a 10% smaller file. Every response is compressed per request, so speed
// wins.
const BROTLI_QUALITY = 5

// Picks Brotli when the client accepts it, then gzip. Quality values are
// ignored, because browsers never send `q=0` for these.
export function preferredEncoding(acceptEncoding: string | null): ContentEncoding | null {
  const accepted = (acceptEncoding ?? "")
    .toLowerCase()
    .split(",")
    .map((entry) => entry.split(";")[0]!.trim())
  if (accepted.includes("br")) return "br"
  if (accepted.includes("gzip")) return "gzip"
  return null
}

export function compress(body: Buffer, encoding: ContentEncoding): Buffer {
  if (encoding === "gzip") return gzipSync(body)
  return brotliCompressSync(body, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: body.length
    }
  })
}
