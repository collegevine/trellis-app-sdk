import { ENV_BASE_URL, ENV_SECRET, readEnv } from "./env.js"

const TINYBIRD_PATH = "tinybird"

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

export type TinybirdParamValue = string | number | boolean
export type TinybirdParams = Record<
  string,
  TinybirdParamValue | null | undefined
>

export interface TinybirdColumnMeta {
  name: string
  type: string
}

export interface TinybirdResponse<TRow = Record<string, unknown>> {
  data: TRow[]
  meta: TinybirdColumnMeta[]
  rows: number
  rows_before_limit_at_least?: number
  statistics?: {
    elapsed: number
    rows_read: number
    bytes_read: number
  }
}

export async function queryTinybirdPipe<TRow = Record<string, unknown>>(
  pipe: string,
  params: TinybirdParams = {}
): Promise<TinybirdResponse<TRow>> {
  const baseUrl = readEnv(ENV_BASE_URL)
  const secret = readEnv(ENV_SECRET)

  const url = pipeUrl(baseUrl, pipe, params)
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${secret}`,
      Accept: "application/json"
    }
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
  return (body as { data: TinybirdResponse<TRow> }).data
}

function pipeUrl(
  baseUrl: string,
  pipe: string,
  params: TinybirdParams
): string {
  const trimmed = baseUrl.replace(/\/+$/, "")
  const path = `${TINYBIRD_PATH}/${encodeURIComponent(pipe)}`
  const queryString = serializeParams(params)
  return queryString
    ? `${trimmed}/${path}?${queryString}`
    : `${trimmed}/${path}`
}

function serializeParams(params: TinybirdParams): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue
    search.append(key, String(value))
  }
  return search.toString()
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
