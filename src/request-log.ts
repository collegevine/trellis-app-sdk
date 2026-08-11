import { getTrellisUser, type TrellisUser } from "./auth/server.js"
import { Logger } from "./logging.js"

// The edge function in CloudFront stamps this header onto every request,
// carrying client IP address.
const CLIENT_IP_HEADER = "x-forwarded-client-ip"

export function logRequestStart(request: Request): void {
  const url = new URL(request.url)
  Logger.info("request start", {
    path: url.pathname,
    ...queryField(url),
    ...clientIpField(request),
    ...userFields(getTrellisUser())
  })
}

export function logRequestEnd({
  request,
  status,
  durationMs
}: {
  request: Request
  status: number
  durationMs: number
}): void {
  Logger.info("request end", {
    path: new URL(request.url).pathname,
    status,
    durationMs
  })
}

function queryField(url: URL): Record<string, string> {
  return url.search ? { query: url.search.slice(1) } : {}
}

function clientIpField(request: Request): Record<string, string> {
  const clientIp = request.headers.get(CLIENT_IP_HEADER)
  return clientIp ? { clientIp } : {}
}

// The SDK never carries a plaintext email; it identifies the signed-in user by
// subject type, display name, and hashed email, grouped under a `user` object.
// Each field is omitted when absent, and the whole object is omitted when none
// are present, so an anonymous-mode request logs no user fields at all.
function userFields(user: TrellisUser | null): Record<string, unknown> {
  if (!user) return {}
  const fields = {
    ...(user.subjectType ? { type: user.subjectType } : {}),
    ...(user.name ? { name: user.name } : {}),
    ...(user.emailHashes.length > 0 ? { emailHashes: user.emailHashes } : {})
  }
  return Object.keys(fields).length > 0 ? { user: fields } : {}
}
