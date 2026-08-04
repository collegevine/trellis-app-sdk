import { request } from "./http.js"

const TINYBIRD_PATH = "tinybird"

/** A single Tinybird query parameter value. */
export type TinybirdParamValue = string | number | boolean

/**
 * Query parameters for a Tinybird pipe. `null` and `undefined` values are
 * dropped from the request rather than sent as empty strings.
 */
export type TinybirdParams = Record<
  string,
  TinybirdParamValue | null | undefined
>

/** Column name and Tinybird type, as reported in a response's `meta`. */
export interface TinybirdColumnMeta {
  name: string
  type: string
}

/**
 * A Tinybird pipe response. `data` holds the rows; the remaining fields are
 * Tinybird's own metadata about the query.
 *
 * @typeParam TRow - The row shape. Defaults to an untyped object; pass a
 * concrete type for typed access to `data`.
 */
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

/**
 * Query a Tinybird pipe and return its rows. Server-only.
 *
 * The deployment's school and agent-instance scope are applied server-side, so
 * do not pass `school_id` or `agent_instance_id` yourself.
 *
 * Only these pipes are reachable; any other name throws {@link TrellisAppApiError}
 * with `status` 404:
 * - `agents__count`
 * - `agents__raw_events`
 * - `agents__field_values`
 * - `agents__constituent_communications`
 *
 * @param pipe - The pipe name to query.
 * @param params - Query parameters; `null`/`undefined` values are omitted.
 * @throws {@link TrellisAppApiError} on any non-2xx response.
 *
 * @example
 * ```ts
 * const { data } = await queryTinybirdPipe("agents__count", {
 *   start_date: "2026-01-01"
 * })
 * ```
 */
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
