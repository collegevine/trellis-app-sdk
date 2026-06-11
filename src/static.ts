// Serves the RRv7 client build straight out of the Lambda deployment
// package. The deploy pipeline zips the client build into /var/task/client/,
// but the request handler created from the server build knows nothing about
// it — without this wrapper every request for /assets/*.js falls through to
// the SSR router and 404s, so deployed apps never hydrate. This wrapper
// short-circuits file requests before auth and before the app handler (the
// auth middleware's asset bypass assumes assets resolve without a session).

import { readFile, stat } from "node:fs/promises"
import { extname, resolve, sep } from "node:path"
import type { FetchHandler } from "./lambda.js"

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json"
}
const FALLBACK_CONTENT_TYPE = "application/octet-stream"

// Vite content-hashes everything under /assets/, so those bundles can be
// cached forever. Other client files (favicon and the like) keep their
// names across deploys and get a short TTL instead.
const HASHED_ASSETS_PREFIX = "/assets/"
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"
const DEFAULT_CACHE_CONTROL = "public, max-age=3600"

// Wrap a request handler so that GET/HEAD requests matching a file under
// `clientDir` are served from disk; everything else falls through.
export function withStaticAssets(
  clientDir: string,
  handler: FetchHandler
): FetchHandler {
  const rootDir = resolve(clientDir)

  return async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return handler(request)
    }

    const pathname = new URL(request.url).pathname
    const filePath = resolveFilePath(rootDir, pathname)
    if (!filePath) return handler(request)

    const stats = await stat(filePath).catch(() => null)
    if (!stats?.isFile()) return handler(request)

    const headers = new Headers({
      "Content-Type": CONTENT_TYPES[extname(filePath)] ?? FALLBACK_CONTENT_TYPE,
      "Cache-Control": pathname.startsWith(HASHED_ASSETS_PREFIX)
        ? IMMUTABLE_CACHE_CONTROL
        : DEFAULT_CACHE_CONTROL
    })
    const body = request.method === "HEAD" ? null : await readFile(filePath)
    return new Response(body, { status: 200, headers })
  }
}

// Map a URL pathname onto a file inside the client build directory.
// Returns null for anything that decodes badly or resolves outside the
// directory (encoded "../" segments survive URL normalization, so the
// prefix check is what actually blocks traversal).
function resolveFilePath(rootDir: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }

  const resolved = resolve(rootDir, `.${decoded}`)
  if (resolved !== rootDir && !resolved.startsWith(rootDir + sep)) return null
  return resolved
}
