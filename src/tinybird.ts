import { request } from "./http.js"

const TINYBIRD_PATH = "tinybird"

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
  return request<TinybirdResponse<TRow>>(pipePath(pipe, params))
}

function pipePath(pipe: string, params: TinybirdParams): string {
  const path = `${TINYBIRD_PATH}/${encodeURIComponent(pipe)}`
  const queryString = serializeParams(params)
  return queryString ? `${path}?${queryString}` : path
}

function serializeParams(params: TinybirdParams): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue
    search.append(key, String(value))
  }
  return search.toString()
}
