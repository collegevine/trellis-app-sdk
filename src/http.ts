import { ENV_BASE_URL, ENV_SECRET, readEnv } from "./env.js"

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
// non-2xx response or when a 2xx body fails to parse as JSON. Reads
// TRELLIS_APP_API_URL and TRELLIS_APP_API_SECRET from the environment on
// every call so per-request secret rotation is observed.
export async function request<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const baseUrl = readEnv(ENV_BASE_URL)
  const secret = readEnv(ENV_SECRET)

  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
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
