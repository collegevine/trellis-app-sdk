import {
  AUTH_MODE_AUTHENTICATED,
  ENV_TRELLIS_APP_API_URL,
  ENV_TRELLIS_APP_API_SECRET,
  readAuthMode,
  readEnv
} from "./env.js"
import {
  SESSION_COOKIE,
  decodeCookie,
  isSessionLive,
  readCookie,
  type SessionCookie
} from "./auth/cookies.js"
import { currentRequest } from "./context.js"

export class TrellisAppApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = "TrellisAppApiError"
    this.status = status
    this.body = body
  }
}

export interface RequestOptions {
  method?: "GET" | "POST"
  // When set, JSON-encoded into the request body and Content-Type is set.
  body?: unknown
}

// Calls the Trellis App API at `path`, parses the `{ data: ... }` envelope,
// and returns the unwrapped payload. Throws TrellisAppApiError on any
// non-2xx response or when a 2xx body fails to parse as JSON. The
// Authorization header depends on the deployment's auth mode:
//
//   - anonymous (default): TRELLIS_APP_API_SECRET from env.
//   - authenticated: per-user access token read from the session cookie
//     on the current request, so the API call is scoped to the signed-
//     in user. The auth middleware is responsible for ensuring a valid
//     session before user code runs; the SDK throws 401 if the cookie
//     is missing or expired.
export async function request<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const baseUrl = readEnv(ENV_TRELLIS_APP_API_URL)
  const authorization = authorizationHeader()

  const headers: Record<string, string> = {
    Authorization: authorization,
    Accept: "application/json"
  }
  if (options.body !== undefined) headers["Content-Type"] = "application/json"

  const response = await fetch(joinUrl(baseUrl, path), {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  })
  const text = await response.text()

  if (!response.ok) {
    throw new TrellisAppApiError(
      `Trellis App API request failed (${response.status})`,
      response.status,
      parseJsonBody(text, response.status, { strict: false })
    )
  }

  const body = parseJsonBody(text, response.status, { strict: true })
  return (body as { data: T }).data
}

function authorizationHeader(): string {
  if (readAuthMode() === AUTH_MODE_AUTHENTICATED) {
    return `Bearer ${readUserAccessToken()}`
  }
  return `Bearer ${readEnv(ENV_TRELLIS_APP_API_SECRET)}`
}

// Read the session cookie off the current request, which the Lambda
// adapter has parked in AsyncLocalStorage. The auth middleware is
// expected to redirect unauthenticated requests before they ever reach
// user code that calls this; the 401 here is a guard against misuse.
function readUserAccessToken(): string {
  const raw = readCookie(currentRequest(), SESSION_COOKIE)
  const session = decodeCookie<SessionCookie>(raw)
  if (!isSessionLive(session)) {
    throw new TrellisAppApiError(
      "No active Trellis user session. The middleware should redirect unauthenticated requests to login.",
      401,
      null
    )
  }
  return session!.accessToken
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path}`
}

function parseJsonBody(
  text: string,
  status: number,
  { strict }: { strict: boolean }
): unknown {
  try {
    return JSON.parse(text)
  } catch {
    if (strict) {
      throw new TrellisAppApiError(
        `Trellis App API returned a non-JSON ${status} response`,
        status,
        text
      )
    }
    return text || null
  }
}
