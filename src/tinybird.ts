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
 * Use the `agents__activity` pipe. It returns the school's agent activity
 * rows, and `q` is ClickHouse SQL run over them, referenced as `_`.
 *
 * Parameters:
 * - `q`: required. Always filter on `created_at` and prefer aggregates. When
 *   you need rows, select a few columns and add a `LIMIT`. An unfiltered
 *   query goes over Tinybird's 100 MiB limit and fails.
 * - `target_agent_instance_ids`: optional, comma-separated agent ids
 *   (`"25038,25041"`). Defaults to the app's own agent.
 *
 * The JSON columns (`action_params_json`, `event_params_json`,
 * `constituent_properties_json`) are text. Read them with
 * `JSONExtractString(col, 'key')`, not `col.key`.
 *
 * School and agent scope are set server-side. Do not pass `school_id`,
 * `agent_instance_id`, or `reachable_agent_instance_ids`.
 *
 * @param pipe - The pipe name to query.
 * @param params - Query parameters; `null`/`undefined` values are omitted.
 * @throws {@link TrellisAppApiError} on any non-2xx response.
 *
 * @example
 * ```ts
 * const { data } = await queryTinybirdPipe("agents__activity", {
 *   q: `SELECT toDate(created_at) AS day, count() AS opens FROM _
 *       WHERE action_or_event_id = 'email-opened'
 *         AND created_at >= now() - INTERVAL 30 DAY
 *       GROUP BY day ORDER BY day`
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
