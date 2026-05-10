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
  type SessionCookie
} from "./auth/cookies.js"

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
//   - authenticated: per-user access token from the SESSION cookie, so
//     the API call is scoped to the signed-in user. The middleware is
//     responsible for ensuring a valid session before the request
//     handler runs; the SDK throws 401 if the cookie is missing.
export async function request<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const baseUrl = readEnv(ENV_TRELLIS_APP_API_URL)
  const authorization = await authorizationHeader()

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

async function authorizationHeader(): Promise<string> {
  if (readAuthMode() === AUTH_MODE_AUTHENTICATED) {
    return `Bearer ${await readUserAccessToken()}`
  }
  return `Bearer ${readEnv(ENV_TRELLIS_APP_API_SECRET)}`
}

// Dynamically import next/headers so anonymous-mode deployments (and
// the SDK's own tests) don't pull in a Next.js dependency they never
// use. In authenticated mode the SDK is, by construction, running
// inside a Next.js server context, so the import resolves.
async function readUserAccessToken(): Promise<string> {
  const { cookies } = await import("next/headers.js")
  const store = await cookies()
  const raw = store.get(SESSION_COOKIE)?.value
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
