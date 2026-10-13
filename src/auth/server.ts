import { currentRequest } from "../context.js"
import { readSession, type TrellisUser } from "./cookies.js"

export type { SubjectType, TrellisUser } from "./cookies.js"

/**
 * Return the currently signed-in Trellis user, or `null` when no live,
 * correctly signed session is attached to the request. Always `null` in
 * anonymous mode. Server-only: call it from a loader, action, or other
 * server-side code that runs inside a request scope established by the SDK's
 * Lambda adapter. Decodes the session cookie locally; does not round-trip to
 * the API. Works whenever any sign-in switch is on, for HQ users, school users,
 * and constituents alike.
 *
 * The user carries `emailHashes`: SHA-256 hex digests of the user's email
 * addresses, each lowercased and whitespace-stripped before hashing. Use them
 * as an opaque per-user identifier, or to recognize "special" users by
 * comparing against digests you compute the same way at build time. A platform
 * user has one; a constituent may have several. See {@link TrellisUser}.
 */
export function getTrellisUser(): TrellisUser | null {
  return readSession(currentRequest())?.user ?? null
}
