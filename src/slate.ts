import { request } from "./http.js"

const SLATE_PATH = "slate"

/**
 * Result of a Slate query. Rows come back as arrays in `columns` order (denser
 * on the wire than per-row objects).
 *
 * @typeParam TRow - The row tuple shape. Defaults to `unknown[]`; callers with
 * a known column shape can supply a tuple type, e.g.
 * `querySlate<[string, number]>(...)`.
 */
export interface SlateQueryResult<TRow = unknown[]> {
  columns: string[]
  rows: TRow[]
}

/**
 * Run a read-only SQL query against the school's Slate CRM. Server-only.
 *
 * Available only for deployments backed by an agent whose product has Slate
 * credentials configured. The Slate schema varies between schools, so table and
 * column names that exist for one school may not exist for another.
 *
 * The query is aborted after 25 seconds. The endpoint is SELECT-only on Slate's
 * side; mutations are rejected.
 *
 * @param query - The SQL to run.
 * @throws {@link TrellisAppApiError} whose `body.error` is one of:
 * `slate_not_configured` (422, no agent or no Slate credential),
 * `slate_timeout` (504), `slate_sql_error` (400, bad SQL or unknown column),
 * `slate_connection_error` (502).
 *
 * @example
 * ```ts
 * const { columns, rows } = await querySlate<[string, string]>(
 *   "SELECT TOP 100 first_name, last_name FROM person"
 * )
 * ```
 */
export async function querySlate<TRow = unknown[]>(
  query: string
): Promise<SlateQueryResult<TRow>> {
  return request<SlateQueryResult<TRow>>(SLATE_PATH, {
    method: "POST",
    body: { query }
  })
}
