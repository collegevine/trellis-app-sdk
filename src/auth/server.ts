import { currentRequest } from "../context.js"
import {
  SESSION_COOKIE,
  decodeCookie,
  isSessionLive,
  readCookie,
  type SessionCookie,
  type TrellisUser
} from "./cookies.js"

export type { SubjectType, TrellisUser } from "./cookies.js"

// Returns the currently signed-in Trellis user, or null when no live
// session is attached to the request. Server-only: must be called from
// a loader, action, or other server-side code that runs inside a
// request scope established by the SDK's Lambda adapter. Decodes the
// session cookie locally; does not round-trip to the API.
//
// The user carries `name` and `emailHashes`: SHA-256 hex digests of the
// user's email addresses (each lowercased and whitespace-stripped before
// hashing). Use the hashes as an opaque per-user identifier, or to
// recognize "special" users by comparing against digests you computed the
// same way at build time. A platform user has one; a constituent may have
// several.
export function getTrellisUser(): TrellisUser | null {
  const raw = readCookie(currentRequest(), SESSION_COOKIE)
  const session = decodeCookie<SessionCookie>(raw)
  if (!isSessionLive(session)) return null

  // Tolerate session cookies minted before emailHashes / subjectType existed:
  // after an app adopts this SDK a browser can still present an older cookie for
  // the rest of its lifetime, and both are non-optional parts of the returned
  // type.
  return {
    ...session!.user,
    emailHashes: session!.user.emailHashes ?? [],
    subjectType: session!.user.subjectType ?? null
  }
}
