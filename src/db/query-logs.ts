// Debug instrumentation for the app's database: wraps a pg Pool to emit logs
// for every query.

import type { Pool, PoolClient, QueryResult } from "pg"
import { type AppLogLine, Logger } from "../logging.js"
import { type ConnectCallback, elapsedMs } from "./instrumentation.js"

// Max values for query parts, above which we truncate to avoid bloating the logs.
const MAX_QUERY_LENGTH = 1000
const MAX_PARAMS = 20
const MAX_ROW_IDS = 100

const DB_QUERY_MESSAGE = "DB query"

// Every query pg runs passes through a pooled client's `query` method, which is
// what we wrap here.
export function instrumentQueryLogging(pool: Pool): Pool {
  const connect = pool.connect.bind(pool) as {
    (): Promise<PoolClient>
    (callback: ConnectCallback): void
  }

  pool.connect = ((callback?: ConnectCallback) => {
    if (callback) {
      return connect((err, client, done) => {
        if (client) instrumentClientQueries(client)
        callback(err, client, done)
      })
    }
    return connect().then(instrumentClientQueries)
  }) as typeof pool.connect

  return pool
}

// We have to keep track of which clients we already wrapped, because
// `pool.connect` can return the same one multiple times.
const instrumentedClients = new WeakSet<PoolClient>()

function instrumentClientQueries(client: PoolClient): PoolClient {
  if (instrumentedClients.has(client)) return client
  instrumentedClients.add(client)

  const query = client.query.bind(client) as (...args: unknown[]) => unknown
  client.query = ((...args: unknown[]) => loggedQuery(query, args)) as typeof client.query
  return client
}

// Run the query untouched and emit a `DB query` line describing it. pg's promise
// and callback forms (`pool.query` drives the callback form internally) both
// yield a result, so we log once it is known. Streaming (cursor/stream) queries
// submit an object and deliver rows out-of-band, so there is no result to wait
// for; we log them up front, with no result fields. Inputs we can't read a SQL
// string from are left alone.
function loggedQuery(
  query: (...args: unknown[]) => unknown,
  args: unknown[]
): unknown {
  const first = args[0]
  const text = queryText(first)
  if (text === undefined) return query(...args)

  const values = queryValues(first, args[1])

  const isSubmittable = isRecord(first) && typeof first.submit === "function"
  if (isSubmittable) {
    void Promise.resolve().then(() => safeEmit(text, values))
    return query(...args)
  }

  const startedAt = performance.now()
  const last = args[args.length - 1]

  if (typeof last === "function") {
    const callback = last as (err: unknown, result: QueryResult) => void
    args[args.length - 1] = (err: unknown, result: QueryResult) => {
      if (!err) safeEmit(text, values, result, elapsedMs(startedAt))
      callback(err, result)
    }
    return query(...args)
  }

  const result = query(...args) as Promise<QueryResult>
  result.then((r) => safeEmit(text, values, r, elapsedMs(startedAt)), () => {})
  return result
}

function safeEmit(
  text: string,
  values: unknown[] | undefined,
  result?: QueryResult,
  durationMs?: number
): void {
  try {
    Logger.debug(
      DB_QUERY_MESSAGE,
      queryLogFields(text, values, result, durationMs)
    )
  } catch {
    // Swallow errors. If we failed to log, that's not worth crashing the query.
  }
}

/**
 * The shape of the `debug`-level line emitted for every database query run
 * through {@link appDatabase}. It is an {@link AppLogLine} whose `message` is
 * `"DB query"`, with the query's details spliced on as top-level fields so each
 * is queryable on its own in CloudWatch. You never construct this; it documents
 * what a query produces in the logs.
 *
 * A streaming (cursor/stream) query is logged when it is dispatched, before any
 * rows arrive, so its line carries `query` and `params` but no `durationMs`,
 * `rowCount`, or `rowIds`.
 *
 * Oversized parts are truncated so one line can't blow up: an overflowing
 * `params` or `rowIds` array keeps its leading entries and ends with a
 * `"… N more"` marker string, and an over-long `query` ends with `"…"`.
 */
export interface DbQueryLog extends AppLogLine {
  /** Always `"DB query"`. */
  message: "DB query"

  /** The SQL text, truncated with a trailing `"…"` past ~1000 characters. */
  query: string

  /**
   * How long, in milliseconds, the statement took. This covers execution on an
   * already-acquired connection, not the cost of obtaining one: when a query is
   * slow because the pool had to open a connection first, that time appears in
   * the accompanying {@link DbConnectLog} instead. Omitted for a streaming
   * query, which is logged before it completes.
   */
  durationMs?: number

  /**
   * The query's bind parameters, present only when it had any. Past 20, the
   * overflow collapses to a trailing `"… N more"` marker.
   */
  params?: unknown[]

  /**
   * How many rows the query returned. Omitted for a streaming query, which is
   * logged before any rows arrive.
   */
  rowCount?: number

  /**
   * The `id` of each returned row, present only when the rows carry an `id`
   * column. Past 100, the overflow collapses to a trailing `"… N more"` marker.
   */
  rowIds?: unknown[]
}

function queryLogFields(
  text: string,
  values: unknown[] | undefined,
  result?: QueryResult,
  durationMs?: number
): Pick<DbQueryLog, "query" | "durationMs" | "params" | "rowCount" | "rowIds"> {
  const rows = result?.rows
  const ids = rows ? rowIds(rows) : undefined
  return {
    query: truncateText(text, MAX_QUERY_LENGTH),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(values && values.length > 0
      ? { params: truncateList(values, MAX_PARAMS) }
      : {}),
    ...(rows ? { rowCount: rows.length } : {}),
    ...(ids ? { rowIds: truncateList(ids, MAX_ROW_IDS) } : {})
  }
}

function queryText(firstArgs: unknown): string | undefined {
  if (typeof firstArgs === "string") return firstArgs
  if (isRecord(firstArgs) && typeof firstArgs.text === "string") return firstArgs.text
  return undefined
}

function queryValues(firstArgs: unknown, secondArg: unknown): unknown[] | undefined {
  if (Array.isArray(secondArg)) return secondArg
  if (isRecord(firstArgs) && Array.isArray(firstArgs.values)) return firstArgs.values
  return undefined
}

// The ids of the returned rows, or undefined when the result has no `id`
// column. Presence is decided from the first row.
function rowIds(rows: unknown[]): unknown[] | undefined {
  const first = rows[0]
  if (!isRecord(first) || !Object.hasOwn(first, "id")) return undefined
  return rows.map((row) => (isRecord(row) ? row.id : undefined))
}

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function truncateList(items: unknown[], max: number): unknown[] {
  if (items.length <= max) return items
  return [...items.slice(0, max), `… ${items.length - max} more`]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
