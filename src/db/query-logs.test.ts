import type { Pool, PoolClient } from "pg"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Logger } from "../logging.js"
import { instrumentQueryLogging } from "./query-logs.js"

describe("DB query logging", () => {
  let logged: unknown[][]

  beforeEach(() => {
    logged = []
    vi.spyOn(Logger, "debug").mockImplementation((...args: unknown[]) => {
      logged.push(args)
    })
  })

  afterEach(() => vi.restoreAllMocks())

  // Instrument a fake pool and hand back a connected client whose underlying
  // `query` is `clientQuery`, mirroring how pg dispenses pooled clients.
  async function connectInstrumented(
    clientQuery: ReturnType<typeof vi.fn>
  ): Promise<PoolClient> {
    const pool = { connect: vi.fn().mockResolvedValue({ query: clientQuery }) }
    instrumentQueryLogging(pool as unknown as Pool)
    return (pool as unknown as Pool).connect()
  }

  it("logs the SQL, parameters, returned row count, and row ids of a query", async () => {
    const clientQuery = vi.fn().mockResolvedValue({
      rows: [
        { id: 7, name: "Frodo" },
        { id: 9, name: "Sam" }
      ],
      rowCount: 2
    })
    const client = await connectInstrumented(clientQuery)

    await client.query("SELECT id, name FROM hobbits WHERE shire = $1", ["yes"])

    expect(clientQuery).toHaveBeenCalledWith(
      "SELECT id, name FROM hobbits WHERE shire = $1",
      ["yes"]
    )
    expect(logged).toEqual([
      [
        "DB query",
        {
          query: "SELECT id, name FROM hobbits WHERE shire = $1",
          params: ["yes"],
          rowCount: 2,
          rowIds: [7, 9]
        }
      ]
    ])
  })

  it("reads the SQL and parameters from a query-config object", async () => {
    const clientQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    const client = await connectInstrumented(clientQuery)

    await client.query({
      text: "UPDATE rings SET bearer = $1 WHERE id = $2",
      values: ["Frodo", 1]
    })

    expect(logged[0]).toEqual([
      "DB query",
      {
        query: "UPDATE rings SET bearer = $1 WHERE id = $2",
        params: ["Frodo", 1],
        rowCount: 0
      }
    ])
  })

  it("logs a callback-form query and still forwards the caller's callback", async () => {
    const result = { rows: [{ id: 1 }], rowCount: 1 }
    const clientQuery = vi.fn((_text, _values, cb) => cb(null, result))
    const client = await connectInstrumented(clientQuery)

    const received: unknown[] = []
    client.query(
      "SELECT id FROM palantiri WHERE keeper = $1",
      ["Denethor"],
      (err: unknown, res: unknown) => received.push(err, res)
    )

    expect(received).toEqual([null, result])
    expect(logged[0]).toEqual([
      "DB query",
      {
        query: "SELECT id FROM palantiri WHERE keeper = $1",
        params: ["Denethor"],
        rowCount: 1,
        rowIds: [1]
      }
    ])
  })

  it("truncates a long query, an oversized parameter list, and an oversized id list", async () => {
    const params = Array.from({ length: 25 }, (_, i) => i)
    const rows = Array.from({ length: 150 }, (_, i) => ({ id: i }))
    const clientQuery = vi
      .fn()
      .mockResolvedValue({ rows, rowCount: rows.length })
    const client = await connectInstrumented(clientQuery)

    await client.query("S".repeat(1200), params)

    const fields = logged[0]![1] as Record<string, unknown>
    expect(fields.query).toBe(`${"S".repeat(1000)}…`)
    expect(fields.params).toEqual([...params.slice(0, 20), "… 5 more"])
    expect(fields.rowCount).toBe(150)
    expect(fields.rowIds).toEqual([
      ...Array.from({ length: 100 }, (_, i) => i),
      "… 50 more"
    ])
  })

  it("omits parameters and row ids when there are none and the rows carry no id", async () => {
    const clientQuery = vi.fn().mockResolvedValue({
      rows: [{ name: "Gandalf" }],
      rowCount: 1
    })
    const client = await connectInstrumented(clientQuery)

    await client.query("SELECT name FROM wizards")

    expect(logged[0]).toEqual([
      "DB query",
      { query: "SELECT name FROM wizards", rowCount: 1 }
    ])
  })

  it("emits no line when the query fails", async () => {
    const clientQuery = vi.fn().mockRejectedValue(new Error("deadlock"))
    const client = await connectInstrumented(clientQuery)

    await expect(client.query("DELETE FROM ents")).rejects.toThrow("deadlock")
    expect(logged).toEqual([])
  })

  it("logs a streaming (submittable) query with no result and passes it through", async () => {
    const cursor = {
      submit: vi.fn(),
      text: "SELECT id FROM ents WHERE awake = $1",
      values: [true]
    }
    const clientQuery = vi.fn().mockReturnValue(cursor)
    const client = await connectInstrumented(clientQuery)

    expect(client.query(cursor)).toBe(cursor)
    expect(clientQuery).toHaveBeenCalledWith(cursor)

    // The line is emitted on a detached promise, so let the microtask run.
    await Promise.resolve()
    expect(logged).toEqual([
      [
        "DB query",
        { query: "SELECT id FROM ents WHERE awake = $1", params: [true] }
      ]
    ])
  })
})
