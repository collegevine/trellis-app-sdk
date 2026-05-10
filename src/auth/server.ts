import { cookies } from "next/headers.js"
import {
  SESSION_COOKIE,
  decodeCookie,
  isSessionLive,
  type SessionCookie,
  type TrellisUser
} from "./cookies.js"

// Returns the currently signed-in Trellis user, or null when no live
// session is attached to the request. Server-only: must be called from
// a server component, server action, or route handler. Decodes the
// session cookie locally; does not round-trip to the API.
export async function getTrellisUser(): Promise<TrellisUser | null> {
  const store = await cookies()
  const raw = store.get(SESSION_COOKIE)?.value
  const session = decodeCookie<SessionCookie>(raw)
  return isSessionLive(session) ? session!.user : null
}
