import { AUTH_MODE_AUTHENTICATED, readAuthMode } from "../env.js"
import { readSignedCookie } from "../cookies.js"

// Short cookie names and the shape of the values stored in them. Both are
// signed cookies (see ../cookies.ts). Shared by the middleware (which sets and
// clears them) and the server-only helpers (which read them).

export const SESSION_COOKIE = "trellis_auth"
export const STATE_COOKIE = "trellis_auth_state"

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
   * constituent. `null` when the platform did not report one.
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
// Unix epoch seconds; we only use it to decide locally when to send
// the user back through the auth flow before the API would 401
// anyway.
export interface SessionCookie {
  accessToken: string
  expiresAt: number
  user: TrellisUser
}

// Stored in STATE_COOKIE during the OAuth redirect round-trip. Lives just long
// enough to verify the callback's `state` and finish the PKCE exchange; cleared
// on the way out. expiresAt (Unix epoch seconds) is part of signed payload, so
// a replay attack is rejected.
export interface StateCookie {
  state: string
  codeVerifier: string
  next: string
  expiresAt: number
}

export function isSessionLive(session: SessionCookie | null): boolean {
  if (!session) return false
  if (!Number.isFinite(session.expiresAt)) return false
  return session.expiresAt * 1000 > Date.now()
}

// The live session attached to `request`, or null. Always null in anonymous mode.
export function readSession(request: Request): SessionCookie | null {
  if (readAuthMode() !== AUTH_MODE_AUTHENTICATED) return null
  const session = readSignedCookie<SessionCookie>(request, SESSION_COOKIE)
  return isSessionLive(session) ? session : null
}
