import { createHmac, timingSafeEqual } from "node:crypto"
import { ENV_COOKIE_NAME_PREFIX, ENV_COOKIE_SIGNING_KEY } from "./env.js"

// Signed cookies scoped to this app.
//
// The wire name is `__Host-App-<prefix>-<name>`. Browsers accept a `__Host-` cookie
// only when it is Secure, has Path=/ and no Domain, so a sibling app under the
// shared apps.collegevine.ai parent cannot plant one for this host.
//
// The wire value is base64url(JSON.stringify({ payload, signature })), where
// payload is JSON.stringify(value) and signature is
// base64url(HMAC-SHA256(key, JSON.stringify([fullName, payload]))). Signing the
// exact payload string avoids any re-serialization ambiguity; including the
// full cookie name binds a value to one cookie of one app.

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/
const KEY_PATTERN = /^[0-9a-fA-F]{64}$/
const SIGNATURE_BYTES = 32
const ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Lax"

function signingKey(): Buffer {
  const hex = process.env[ENV_COOKIE_SIGNING_KEY]
  if (!hex) throw new Error(`${ENV_COOKIE_SIGNING_KEY} is not set`)
  if (!KEY_PATTERN.test(hex)) {
    throw new Error(`${ENV_COOKIE_SIGNING_KEY} must be 64 hex characters`)
  }
  return Buffer.from(hex, "hex")
}

function fullCookieName(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Invalid cookie name ${JSON.stringify(name)}`)
  }
  const prefix = process.env[ENV_COOKIE_NAME_PREFIX]
  if (!prefix) throw new Error(`${ENV_COOKIE_NAME_PREFIX} is not set`)
  return `__Host-App-${prefix}-${name}`
}

function sign(key: Buffer, fullName: string, payload: string): Buffer {
  return createHmac("sha256", key)
    .update(JSON.stringify([fullName, payload]))
    .digest()
}

/**
 * Build a `Set-Cookie` header value that stores `value` in a signed cookie.
 *
 * The value is signed, not encrypted: the visitor can read it, but any edit
 * makes {@link readSignedCookie} return `null`. Do not put secrets in it. The
 * signing key and the cookie name prefix come from the platform
 * (`TRELLIS_APP_COOKIE_SIGNING_KEY`, `TRELLIS_APP_COOKIE_NAME_PREFIX`), so a
 * cookie from one app is never visible to another. The cookie is `HttpOnly`,
 * `Secure`, `SameSite=Lax`, scoped to `/`.
 *
 * `maxAgeSeconds` only tells the browser when to drop the cookie; a copy the
 * visitor kept still verifies afterwards. If the value must stop being honored
 * at some point, store an expiry inside it and check that after reading.
 *
 * @param cookie The cookie to set.
 * @param cookie.name Short name, letters, digits, `_` and `-` only. Throws otherwise.
 * @param cookie.value Any JSON-serializable value.
 * @param cookie.maxAgeSeconds Lifetime in seconds.
 *
 * @example
 * ```ts
 * import { signedCookieHeader } from "@collegevine/trellis-app-sdk"
 *
 * export async function action() {
 *   return new Response(null, {
 *     status: 302,
 *     headers: {
 *       Location: "/",
 *       "Set-Cookie": signedCookieHeader({
 *         name: "prefs",
 *         value: { theme: "dark" },
 *         maxAgeSeconds: 86400
 *       })
 *     }
 *   })
 * }
 * ```
 */
export function signedCookieHeader({
  name,
  value,
  maxAgeSeconds
}: {
  name: string
  value: unknown
  maxAgeSeconds: number
}): string {
  const fullName = fullCookieName(name)
  const payload = JSON.stringify(value)
  const signature = sign(signingKey(), fullName, payload).toString("base64url")
  const encoded = Buffer.from(
    JSON.stringify({ payload, signature }),
    "utf8"
  ).toString("base64url")
  return `${fullName}=${encoded}; ${ATTRIBUTES}; Max-Age=${maxAgeSeconds}`
}

/**
 * Build a `Set-Cookie` header value that deletes the signed cookie `name` set
 * by {@link signedCookieHeader}.
 *
 * @example
 * ```ts
 * import { clearedCookieHeader } from "@collegevine/trellis-app-sdk"
 *
 * export async function action() {
 *   return new Response(null, {
 *     status: 302,
 *     headers: { Location: "/", "Set-Cookie": clearedCookieHeader("prefs") }
 *   })
 * }
 * ```
 */
export function clearedCookieHeader(name: string): string {
  return `${fullCookieName(name)}=; ${ATTRIBUTES}; Max-Age=0`
}

/**
 * Read and verify the signed cookie `name` set by {@link signedCookieHeader}.
 * Returns `null` when the cookie is absent, malformed, or its signature does
 * not match (for example because the visitor edited it). The value is
 * readable by the visitor but cannot be changed by them.
 *
 * The result is whatever was stored; validate its shape if the type matters.
 *
 * @example
 * ```ts
 * import { readSignedCookie } from "@collegevine/trellis-app-sdk"
 *
 * export async function loader({ request }: { request: Request }) {
 *   const prefs = readSignedCookie<{ theme: string }>(request, "prefs")
 *   return { theme: prefs?.theme ?? "light" }
 * }
 * ```
 */
export function readSignedCookie<T>(request: Request, name: string): T | null {
  const fullName = fullCookieName(name)
  const key = signingKey()
  const raw = readCookie(request, fullName)
  if (!raw) return null
  try {
    const envelope: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
    if (typeof envelope !== "object" || envelope === null) return null

    const { payload, signature } = envelope as Record<string, unknown>
    if (typeof payload !== "string" || typeof signature !== "string") return null

    const given = Buffer.from(signature, "base64url")
    if (given.length !== SIGNATURE_BYTES) return null
    if (!timingSafeEqual(given, sign(key, fullName, payload))) return null

    return JSON.parse(payload) as T
  } catch {
    return null
  }
}

// `split("=", 2)` drops anything after a second `=`, which is harmless here:
// signed values are unpadded base64url and never contain `=`.
function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie")
  if (!header) return undefined
  for (const part of header.split(";")) {
    const [k, v] = part.trim().split("=", 2)
    if (k === name) return v
  }
  return undefined
}
