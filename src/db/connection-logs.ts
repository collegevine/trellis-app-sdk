// Debug instrumentation for the app's database connections. A per-query log
// cannot explain a slow first query, because acquiring a client is where the
// cost hides: the pool hands back an idle connection when one is free, and
// otherwise opens a new one, which means minting an RDS IAM auth token,
// completing the TLS handshake to the proxy, and authenticating. On a cold
// Lambda container that whole sequence lands on whichever query runs first and
// dwarfs the statement itself, so the two phases are timed separately here.

import type { Pool, PoolClient } from "pg"
import { type AppLogLine, Logger } from "../logging.js"
import { type ConnectCallback, elapsedMs } from "./instrumentation.js"

const CONNECT_MESSAGE = "DB connect"
const AUTH_TOKEN_MESSAGE = "DB auth token"

/**
 * The shape of the `debug`-level line emitted each time a client is acquired
 * from the pool behind {@link appDatabase}. It is an {@link AppLogLine} whose
 * `message` is `"DB connect"`. You never construct this; it documents what an
 * acquire produces in the logs.
 *
 * An acquire that reused an idle connection takes well under a millisecond. One
 * that had to open a new physical connection is far slower, and is accompanied
 * by a {@link DbAuthTokenLog} line, since a token is minted only for a new
 * connection. The difference between the two durations is what the TLS
 * handshake and Postgres authentication cost.
 */
export interface DbConnectLog extends AppLogLine {
  /** Always `"DB connect"`. */
  message: "DB connect"

  /** How long, in milliseconds, the acquire took. */
  durationMs: number

  /** Present only when the acquire failed. */
  failed?: true

  /** The stringified failure, present only when the acquire failed. */
  error?: string
}

/**
 * The shape of the `debug`-level line emitted when an RDS IAM auth token is
 * minted for a new database connection. It is an {@link AppLogLine} whose
 * `message` is `"DB auth token"`. You never construct this; it documents what a
 * mint produces in the logs.
 *
 * The token is a credential and is never logged -- only how long it took to
 * produce. Signing is local to the process, so a large duration here points at
 * resolving the execution role's credentials rather than at the signature.
 *
 * pg mints a token only when it opens a new physical connection, so the
 * presence of this line marks the accompanying {@link DbConnectLog} as a real
 * connection rather than a reuse.
 */
export interface DbAuthTokenLog extends AppLogLine {
  /** Always `"DB auth token"`. */
  message: "DB auth token"

  /** How long, in milliseconds, minting the token took. */
  durationMs: number

  /** Present only when the mint failed. */
  failed?: true

  /** The stringified failure, present only when the mint failed. */
  error?: string
}

// Wrap the pool's `connect` so every acquire is timed, in both the promise form
// and the callback form that `pool.query` uses internally.
export function instrumentConnectLogging(pool: Pool): Pool {
  const connect = pool.connect.bind(pool) as {
    (): Promise<PoolClient>
    (callback: ConnectCallback): void
  }

  pool.connect = ((callback?: ConnectCallback) => {
    const startedAt = performance.now()

    if (callback) {
      return connect((err, client, done) => {
        emit(CONNECT_MESSAGE, startedAt, err)
        callback(err, client, done)
      })
    }

    return connect().then(
      (client) => {
        emit(CONNECT_MESSAGE, startedAt)
        return client
      },
      (error: unknown) => {
        emit(CONNECT_MESSAGE, startedAt, error)
        throw error
      }
    )
  }) as typeof pool.connect

  return pool
}

/**
 * Wrap an auth-token mint so it emits a {@link DbAuthTokenLog}. Returns a
 * function of the same shape, suitable as pg's `password` option, which pg
 * calls once per new physical connection.
 */
export function logAuthTokenTiming(
  mint: () => Promise<string>
): () => Promise<string> {
  return async () => {
    const startedAt = performance.now()
    try {
      const token = await mint()
      emit(AUTH_TOKEN_MESSAGE, startedAt)
      return token
    } catch (error) {
      emit(AUTH_TOKEN_MESSAGE, startedAt, error)
      throw error
    }
  }
}

// Emit one timed line. Never logs the value that was produced: a token is a
// credential, and a client carries connection state, so only the duration and
// the outcome are recorded.
function emit(message: string, startedAt: number, error?: unknown): void {
  try {
    Logger.debug(message, {
      durationMs: elapsedMs(startedAt),
      ...(error ? { failed: true, error: String(error) } : {})
    })
  } catch {
    // Swallow errors. Failing to log is not worth breaking a connection over.
  }
}
