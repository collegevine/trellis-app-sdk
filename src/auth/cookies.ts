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

// Which kind of subject is signed in. A public wire contract shared with the
// Rails `Trellis::Apps::SubjectType` module.
export type SubjectType = "hq_user" | "school_user" | "constituent"

export interface TrellisUser {
  name: string | null

  // SHA-256 hex digests of the user's email addresses, each lowercased and
  // stripped of surrounding whitespace before hashing. Stable public contract:
  // an app can hash a known email the same way offline and compare against
  // these. A platform user has one; a constituent may have several.
  emailHashes: string[]

  // Whether the signed-in subject is an HQ user, a school user, or a
  // constituent. Null on session cookies minted before this field existed: a
  // browser can present an older cookie for the rest of its 14-day life after
  // an app adopts this SDK version.
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

// Stored in STATE_COOKIE during the redirect round-trip. Lives just
// long enough to verify the callback's `state` and finish the PKCE
// exchange; cleared on the way out.
export interface StateCookie {
  state: string
  codeVerifier: string
  next: string
}

export function encodeCookie(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
}

export function decodeCookie<T>(raw: string | undefined): T | null {
  if (!raw) return null
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8")
    return JSON.parse(json) as T
  } catch {
    return null
  }
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
