import { currentRequest } from "../context.js"
import {
  SESSION_COOKIE,
  decodeCookie,
  isSessionLive,
  readCookie,
  type SessionCookie,
  type TrellisUser
} from "./cookies.js"

// Returns the currently signed-in Trellis user, or null when no live
// session is attached to the request. Server-only: must be called from
// a loader, action, or other server-side code that runs inside a
// request scope established by the SDK's Lambda adapter. Decodes the
// session cookie locally; does not round-trip to the API.
export function getTrellisUser(): TrellisUser | null {
  const raw = readCookie(currentRequest(), SESSION_COOKIE)
  const session = decodeCookie<SessionCookie>(raw)
  return isSessionLive(session) ? session!.user : null
}
