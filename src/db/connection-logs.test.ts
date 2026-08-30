import type { Pool, PoolClient } from "pg"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Logger } from "../logging.js"
import { instrumentConnectLogging, logAuthTokenTiming } from "./connection-logs.js"

describe("DB connection logging", () => {
  let logged: unknown[][]

  beforeEach(() => {
    logged = []
    vi.spyOn(Logger, "debug").mockImplementation((...args: unknown[]) => {
      logged.push(args)
    })
  })

  afterEach(() => vi.restoreAllMocks())

  describe("instrumentConnectLogging", () => {
    it("times a promise-form acquire and passes the client through", async () => {
      const client = { query: vi.fn() } as unknown as PoolClient
      const pool = { connect: vi.fn().mockResolvedValue(client) }
      instrumentConnectLogging(pool as unknown as Pool)

      await expect((pool as unknown as Pool).connect()).resolves.toBe(client)

      expect(logged).toEqual([
        ["DB connect", { durationMs: expect.any(Number) }]
      ])
    })

    it("times the callback form that pool.query drives internally", async () => {
      const client = { query: vi.fn() } as unknown as PoolClient
      const done = vi.fn()
      const pool = {
        connect: vi.fn((cb: (e: undefined, c: PoolClient, d: () => void) => void) =>
          cb(undefined, client, done)
        )
      }
      instrumentConnectLogging(pool as unknown as Pool)

      const received = await new Promise((resolve) => {
        ;(pool as unknown as Pool).connect((err, c, d) => resolve({ err, c, d }))
      })

      expect(received).toEqual({ err: undefined, c: client, d: done })
      expect(logged).toEqual([
        ["DB connect", { durationMs: expect.any(Number) }]
      ])
    })

    it("reports how long the acquire actually took", async () => {
      const SLOW_MS = 25
      const pool = {
        connect: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ query: vi.fn() }), SLOW_MS)
            )
        )
      }
      instrumentConnectLogging(pool as unknown as Pool)

      await (pool as unknown as Pool).connect()

      const fields = logged[0]![1] as { durationMs: number }
      // A floor rather than the exact sleep: setTimeout can fire marginally
      // early against performance.now(). Still catches a zero duration.
      expect(fields.durationMs).toBeGreaterThan(SLOW_MS / 2)
    })

    it("marks a failed acquire and still rejects", async () => {
      const boom = new Error("proxy refused the connection")
      const pool = { connect: vi.fn().mockRejectedValue(boom) }
      instrumentConnectLogging(pool as unknown as Pool)

      await expect((pool as unknown as Pool).connect()).rejects.toBe(boom)

      expect(logged).toEqual([
        [
          "DB connect",
          {
            durationMs: expect.any(Number),
            failed: true,
            error: "Error: proxy refused the connection"
          }
        ]
      ])
    })
  })

  describe("logAuthTokenTiming", () => {
    it("times the mint, returns the token, and never logs it", async () => {
      const mint = vi.fn().mockResolvedValue("iam-token-speak-friend-and-enter")
      const timed = logAuthTokenTiming(mint)

      await expect(timed()).resolves.toBe("iam-token-speak-friend-and-enter")

      expect(logged).toEqual([
        ["DB auth token", { durationMs: expect.any(Number) }]
      ])
      // The token is a credential; a timing log must never carry its value.
      expect(JSON.stringify(logged)).not.toContain("speak-friend-and-enter")
    })

    it("marks a failed mint and still rejects", async () => {
      const boom = new Error("no credentials in the provider chain")
      const timed = logAuthTokenTiming(vi.fn().mockRejectedValue(boom))

      await expect(timed()).rejects.toBe(boom)

      expect(logged).toEqual([
        [
          "DB auth token",
          {
            durationMs: expect.any(Number),
            failed: true,
            error: "Error: no credentials in the provider chain"
          }
        ]
      ])
    })
  })
})
