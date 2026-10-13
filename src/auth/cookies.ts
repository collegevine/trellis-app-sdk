import { createHmac, timingSafeEqual } from "node:crypto"
import {
  AUTH_MODE_AUTHENTICATED, ENV_SESSION_SIGNING_KEY, readAuthMode, readEnv
} from "../env.js"

// Cookie names and the on-disk shape of the values stored in them.
// Shared by middleware (which sets/clears them) and the server-only
// helpers in `server.ts` (which read them).

export const SESSION_COOKIE = "__trellis_auth"
export const STATE_COOKIE = "__trellis_auth_state"

export const SESSION_MAX_AGE_SECONDS = 14 * 24 * 60 * 60
export const STATE_MAX_AGE_SECONDS = 10 * 60

export const LOGIN_PATH = "/api/trellis-auth/login"
export const CALLBACK_PATH = "/api/trellis-auth/callback"
export const LOGOUT_PATH = "/api/trellis-auth/logout"

/** Which kind of subject is signed in. */
export type SubjectType = "hq_user" | "school_user" | "constituent"

/** The signed-in user, as returned by {@link getTrellisUser}. */
export interface TrellisUser {
  /** The user's display name, or `null` when unknown. */
  name: string | null

  /**
   * SHA-256 hex digests of the user's email addresses, each lowercased and
   * stripped of surrounding whitespace before hashing. Stable public contract:
   * an app can hash a known email the same way offline and compare against
   * these. A platform user has one; a constituent may have several.
   */
  emailHashes: string[]

  /**
   * Whether the signed-in subject is an HQ user, a school user, or a
   * constituent. `null` when the platform does not supply a subject type.
   */
  subjectType: SubjectType | null
}

// The `user` object as it arrives from Rails' token endpoint: snake_case, to
// match the sibling access_token / expires_at fields of that response. Mapped
// to the camelCase TrellisUser at the SDK boundary by userFromWire, so the
// public API stays camelCase and both middlewares decode it identically.
export interface WireTrellisUser {
  name: string | null
  email_hashes?: string[]
  subject_type?: SubjectType | null
}

export function userFromWire(wire: WireTrellisUser): TrellisUser {
  return {
    name: wire.name ?? null,
    emailHashes: wire.email_hashes ?? [],
    subjectType: wire.subject_type ?? null
  }
}

// Stored in SESSION_COOKIE. The access token is the credential the
// SDK forwards to the API on every server-side call. expiresAt is
// Unix epoch seconds, covered by the signature along with the identity.
export interface SessionCookie {
  accessToken: string
  expiresAt: number
  user: TrellisUser
}

// Stored in STATE_COOKIE during the redirect round-trip. Lives just
// long enough to verify the callback's `state` and finish the PKCE
// exchange; cleared on the way out.
export interface StateCookie {
  state: string
  codeVerifier: string
  next: string
  expiresAt: number
}

type CookiePurpose = typeof SESSION_COOKIE | typeof STATE_COOKIE

function signingKey(): Buffer {
  const key = readEnv(ENV_SESSION_SIGNING_KEY)
  if (!/^[a-fA-F0-9]{64}$/.test(key)) {
    throw new Error(`${ENV_SESSION_SIGNING_KEY} must be a 32-byte random key encoded as 64 hex characters`)
  }
  return Buffer.from(key, "hex")
}

// The purpose prevents a signed login-state cookie being used as a session.
function signature(payload: string, purpose: CookiePurpose, key: Buffer): Buffer {
  return createHmac("sha256", key).update(`${purpose}.v1.${payload}`).digest()
}

export function encodeCookie(value: unknown, purpose: CookiePurpose = SESSION_COOKIE): string {
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
  return `v1.${payload}.${signature(payload, purpose, signingKey()).toString("base64url")}`
}

export function decodeCookie<T>(raw: string | undefined, purpose: CookiePurpose = SESSION_COOKIE): T | null {
  if (!raw) return null
  // Configuration failures must not silently become an unsigned fallback.
  const key = signingKey()
  const match = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(raw)
  if (!match) return null
  const payload = match[1]!
  const supplied = Buffer.from(match[2]!, "base64url")
  if (!timingSafeEqual(supplied, signature(payload, purpose, key))) return null
  try {
    const json = Buffer.from(payload, "base64url").toString("utf8")
    return JSON.parse(json) as T
  } catch {
    return null
  }
}

export function readSession(request: Request): SessionCookie | null {
  // Public deployments must ignore cookies left over from authenticated mode.
  if (readAuthMode() !== AUTH_MODE_AUTHENTICATED) return null
  const session = decodeCookie<SessionCookie>(readCookie(request, SESSION_COOKIE))
  return isSessionLive(session) ? session : null
}

export function isSessionLive(session: SessionCookie | null): boolean {
  if (!session) return false
  if (!Number.isFinite(session.expiresAt)) return false
  return session.expiresAt * 1000 > Date.now()
}

// Pluck a single cookie value off a Request. Returns undefined when
// the Cookie header is missing or the named cookie is not present.
//
// We split on `=` and rejoin the tail because JS's `String#split(sep,
// limit)` truncates extras rather than putting the remainder into the
// last element, which would silently corrupt any value containing `=`.
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie")
  if (!header) return undefined
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=")
    if (k === name) return v.join("=")
  }
  return undefined
}
