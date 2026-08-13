import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installJsonLogging, Logger } from "./logging.js"

describe("logging", () => {
  let stdout: Record<string, unknown>[]
  let stderr: Record<string, unknown>[]

  const captureInto = (sink: Record<string, unknown>[]) => (chunk: unknown) => {
    const line = String(chunk)
    expect(line.endsWith("\n")).toBe(true)
    sink.push(JSON.parse(line))
    return true
  }

  beforeEach(() => {
    stdout = []
    stderr = []
    vi.spyOn(process.stdout, "write").mockImplementation(captureInto(stdout))
    vi.spyOn(process.stderr, "write").mockImplementation(captureInto(stderr))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("installJsonLogging", () => {
    let restore: () => void
    let originalLog: typeof console.log

    beforeEach(() => {
      originalLog = console.log
      restore = installJsonLogging()
    })

    afterEach(() => restore()) // Do not eta-reduce! Different meaning!

    it("emits one entry per call, with level and message", () => {
      console.log("May the Force be with you")
      console.info()

      expect(stdout).toEqual([
        { level: "info", message: "May the Force be with you" },
        { level: "info" }
      ])
    })

    it("maps each console method to its level and stream", () => {
      console.debug("scanning")
      console.info("holding")
      console.log("holding")
      console.warn("shields low")
      console.error("we're hit")

      expect(stdout.map((entry) => entry.level)).toEqual(["debug", "info", "info"])
      expect(stderr.map((entry) => entry.level)).toEqual(["warn", "error"])
    })

    it("attaches the remaining arguments as params when the first is a string", () => {
      console.log("jump to lightspeed", { destination: "Hoth" }, 3)

      expect(stdout[0]).toEqual({
        level: "info",
        message: "jump to lightspeed",
        params: [{ destination: "Hoth" }, 3]
      })
    })

    it("splices a lone hash that follows a string message onto the line", () => {
      console.info("order placed", { orderId: 7, total: 42 })

      expect(stdout[0]).toEqual({
        level: "info",
        message: "order placed",
        orderId: 7,
        total: 42
      })
    })

    it("puts every argument in params, and no message, when the first is not a string", () => {
      console.warn({ code: "E_HYPERDRIVE" }, 7)

      expect(stderr[0]).toEqual({
        level: "warn",
        params: [{ code: "E_HYPERDRIVE" }, 7]
      })
      expect(stderr[0]).not.toHaveProperty("message")
    })

    it("splices a lone hash argument directly onto the line, not nested under params", () => {
      console.error({ code: "E_HYPERDRIVE", detail: "offline" })

      expect(stderr[0]).toEqual({
        level: "error",
        code: "E_HYPERDRIVE",
        detail: "offline"
      })
    })

    it("lets a spliced hash override built-in fields such as level", () => {
      console.info({ level: "warn", code: "E_REACTOR" })

      expect(stdout[0]).toEqual({ level: "warn", code: "E_REACTOR" })
    })

    it("still wraps a lone non-hash argument in the params array", () => {
      console.log([1, 2, 3])
      console.info(42)

      expect(stdout[0]).toEqual({ level: "info", params: [[1, 2, 3]] })
      expect(stdout[1]).toEqual({ level: "info", params: [42] })
    })

    it("does not throw on circular references or BigInt", () => {
      const cycle: Record<string, unknown> = { name: "loop" }
      cycle.self = cycle

      expect(() => console.log("recursing", cycle, 10n)).not.toThrow()

      expect(stdout[0]).toEqual({
        level: "info",
        message: "recursing",
        params: [{ name: "loop", self: "[Circular]" }, "10"]
      })
    })

    it("restores the native console methods", () => {
      expect(console.log).not.toBe(originalLog)
      restore()
      expect(console.log).toBe(originalLog)
    })

    it("ignores a second install, and its restore leaves the patch in place", () => {
      const patched = console.log
      const secondRestore = installJsonLogging()
      expect(console.log).toBe(patched)

      secondRestore()
      expect(console.log).toBe(patched)
    })
  })

  describe("Logger", () => {
    // No installJsonLogging() here: Logger writes on its own, so this also proves
    // it does not depend on console having been patched.
    it("emits the same JSON shapes as console, mapping level and stream per method", () => {
      Logger.info("mission briefing", { sector: "Outer Rim" })
      Logger.debug("scanning")
      Logger.warn("power low")
      Logger.error({ code: "E_REACTOR" })

      expect(stdout).toEqual([
        { level: "info", message: "mission briefing", sector: "Outer Rim" },
        { level: "debug", message: "scanning" }
      ])
      expect(stderr).toEqual([
        { level: "warn", message: "power low" },
        { level: "error", code: "E_REACTOR" }
      ])
    })
  })
})