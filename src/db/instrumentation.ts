// Pieces shared by the database debug instrumentation: the connection logs and
// the query logs both wrap `pool.connect` and both report a duration, and the
// two are only comparable if they measure and round it the same way.

import type { PoolClient } from "pg"

// pg's callback form of `pool.connect`. `pool.query` drives it internally, so
// any wrapper of `connect` has to handle this shape as well as the promise one.
export type ConnectCallback = (
  err: Error | undefined,
  client: PoolClient | undefined,
  done: (release?: unknown) => void
) => void

// Two decimals: enough that a sub-millisecond query reads as 0.42 rather than
// collapsing to 0, which matters when the point of the line is to show that the
// statement was never the expensive part.
const DURATION_DECIMALS = 2

export function elapsedMs(startedAt: number): number {
  const factor = 10 ** DURATION_DECIMALS
  return Math.round((performance.now() - startedAt) * factor) / factor
}
