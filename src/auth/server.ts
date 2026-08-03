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

/**
 * Return the currently signed-in Trellis user, or `null` when no live session
 * is attached to the request. Server-only: call it from a loader, action, or
 * other server-side code that runs inside a request scope established by the
 * SDK's Lambda adapter. Decodes the session cookie locally; does not round-trip
 * to the API. Works whenever any sign-in switch is on, for HQ users, school
 * users, and constituents alike.
 *
 * The user carries `emailHashes`: SHA-256 hex digests of the user's email
 * addresses, each lowercased and whitespace-stripped before hashing. Use them as
 * an opaque per-user identifier, or to recognize "special" users by comparing
 * against digests you compute the same way at build time. A platform user has
 * one; a constituent may have several. See {@link TrellisUser}.
 */
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
