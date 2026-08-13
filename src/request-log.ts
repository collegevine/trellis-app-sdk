import { getTrellisUser, type SubjectType, type TrellisUser } from "./auth/server.js"
import { type AppLogLine, Logger } from "./logging.js"

// The edge function in CloudFront stamps this header onto every request,
// carrying client IP address.
const CLIENT_IP_HEADER = "x-forwarded-client-ip"

/**
 * The `info`-level line the platform emits at the start of every request it
 * serves, before the app's handler runs. It is an {@link AppLogLine} whose
 * `message` is `"request start"`, with the request's details spliced on as
 * top-level fields so each is queryable on its own in CloudWatch. You never
 * construct this; it documents what a served request produces in the logs.
 *
 * Its counterpart {@link RequestEndLog} is emitted once the response is ready.
 */
export interface RequestStartLog extends AppLogLine {
  /** Always `"request start"`. */
  message: "request start"

  /** The request URL's path, without the query string. */
  path: string

  /** The query string with its leading `?` stripped, present only when the URL had one. */
  query?: string

  /** The client's IP address */
  clientIp?: string

  /**
   * The signed-in user's identity, present only on an authenticated request. The
   * SDK never logs a plaintext email, so the user is identified by subject type,
   * display name, and hashed emails; each field is omitted when absent.
   */
  user?: {
    /** Type of the user. */
    type?: SubjectType

    /** The user's display name. */
    name?: string

    /** One SHA-256 hex digest per email address on the user's identity. */
    emailHashes?: string[]
  }
}

export function logRequestStart(request: Request): void {
  const url = new URL(request.url)
  Logger.info("request start", {
    path: url.pathname,
    ...queryField(url),
    ...clientIpField(request),
    ...userFields(getTrellisUser())
  } satisfies Pick<RequestStartLog, "path" | "query" | "clientIp" | "user">)
}

/**
 * The `info`-level line the platform emits once a request's response is ready,
 * paired with the {@link RequestStartLog} logged when it began. It is an
 * {@link AppLogLine} whose `message` is `"request end"`, with the outcome spliced
 * on as top-level fields.
 */
export interface RequestEndLog extends AppLogLine {
  /** Always `"request end"`. */
  message: "request end"

  /** The request URL's path, without the query string. */
  path: string

  /** The HTTP status code of the response. */
  status: number

  /** How long, in milliseconds, the request took to serve. */
  durationMs: number
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
  } satisfies Pick<RequestEndLog, "path" | "status" | "durationMs">)
}

function queryField(url: URL): Pick<RequestStartLog, "query"> {
  return url.search ? { query: url.search.slice(1) } : {}
}

function clientIpField(request: Request): Pick<RequestStartLog, "clientIp"> {
  const clientIp = request.headers.get(CLIENT_IP_HEADER)
  return clientIp ? { clientIp } : {}
}

// The SDK never carries a plaintext email; it identifies the signed-in user by
// subject type, display name, and hashed email, grouped under a `user` object.
// Each field is omitted when absent, and the whole object is omitted when none
// are present, so an anonymous-mode request logs no user fields at all.
function userFields(user: TrellisUser | null): Pick<RequestStartLog, "user"> {
  if (!user) return {}
  const fields = {
    ...(user.subjectType ? { type: user.subjectType } : {}),
    ...(user.name ? { name: user.name } : {}),
    ...(user.emailHashes.length > 0 ? { emailHashes: user.emailHashes } : {})
  }
  return Object.keys(fields).length > 0 ? { user: fields } : {}
}
