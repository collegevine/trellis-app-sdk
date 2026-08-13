// Structured JSON logging for Trellis Apps, centered on `Logger`. Its methods
// emit one JSON object per line (see `AppLogLine`) straight to stdout/stderr,
// ready for structured querying in CloudWatch. `installJsonLogging()` then
// redirects the app's console.* methods to `Logger`, so plain `console.log`
// calls produce the same structured lines with no code change.
//
// Lines go straight to the streams rather than through the Lambda runtime's own
// console wrapper, which would otherwise fold a timestamp and request id in
// front of the payload and leave the line no longer parseable as pure JSON.
// Instead we stamp those on ourselves as structured fields: every line carries
// an emit timestamp, the AWS request id of the invocation serving it (when
// emitted within a request), and the deployment id the app was built from
// (TRELLIS_APP_DEPLOYMENT_ID).
//
// Emission is gated on a configured minimum level (TRELLIS_APP_LOG_LEVEL): a
// line is written only when its level is at or above the threshold, so the
// platform can dial verbosity up or down without an app redeploy.

import { currentRequestId } from "./context.js"
import { ENV_DEPLOYMENT_ID, ENV_LOG_LEVEL } from "./env.js"

type LogMethod = "debug" | "log" | "info" | "warn" | "error"

/**
 * Severity of a log line, and the name of the {@link Logger} method that emits
 * it. A redirected `console.log`, which has no level of its own, maps to `info`.
 */
export type LogLevel = "debug" | "info" | "warn" | "error"

// Which Logger method each patched console method forwards to.
const LEVEL_BY_CONSOLE_METHOD: Record<LogMethod, LogLevel> = {
  debug: "debug",
  log: "info",
  info: "info",
  warn: "warn",
  error: "error"
}

const CONSOLE_METHODS = Object.keys(LEVEL_BY_CONSOLE_METHOD) as LogMethod[]

// Mirrors console's own routing. In CloudWatch both streams land in the same
// log group, so this only matters for local runs and anything reading the
// streams apart.
const STDERR_LEVELS: ReadonlySet<LogLevel> = new Set(["warn", "error"])

// Ascending severity. A line is emitted only when its level ranks at or above
// the configured threshold.
const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
}

// Applied when TRELLIS_APP_LOG_LEVEL is unset or not one of the levels above.
const DEFAULT_LOG_LEVEL: LogLevel = "info"

/**
 * The JSON shape of a single log line emitted by {@link Logger}.
 *
 * Every `Logger` call is emitted as one line of JSON in this shape (one object
 * per line), so logs are queryable as structured data in CloudWatch rather than
 * as free text. The app's `console.*` methods are redirected to `Logger`, so
 * plain `console.log` calls turn into the same shape. You do not construct this
 * structure yourself. It's here merely to document what a log call produces.
 * See {@link Logger} for how call arguments map onto `message` and `params`.
 *
 * The platform emits its own lines in this shape around the work it does for an
 * app: a {@link RequestStartLog} and a {@link RequestEndLog} bracket every
 * request, and each database query adds a {@link DbQueryLog}.
 */
export interface AppLogLine {
  /** ISO 8601 instant the line was emitted. */
  timestamp: string

  /** Severity: the {@link Logger} method that emitted the line. */
  level: LogLevel

  /**
   * The AWS request id of the invocation that emitted the line. Omitted for
   * lines emitted outside a request, such as at cold start.
   */
  requestId?: string

  /** The id of the app deployment that emits the log. */
  deploymentId?: string

  /** The first argument when it is a string; omitted otherwise. */
  message?: string

  /**
   * The line's structured payload: the arguments not captured by `message` — the
   * trailing arguments when the first is a string, or every argument when the
   * first is not. Omitted when there is nothing to attach, or when a hash is
   * spliced onto the line instead (see the index signature below).
   */
  params?: Record<string, unknown> | unknown[]

  /**
   * A lone hash argument — or a string message followed by a lone hash — is
   * spliced onto the line as its own top-level fields rather than nested under
   * `params`, so each stays queryable directly. On a name clash these fields
   * overwrite the built-ins above — including `level` — so avoid
   * `level`/`message`/`params` keys in such a hash unless you mean to replace
   * them.
   */
  [field: string]: unknown
}

/**
 * The Trellis App logger — the canonical way to log from app code. Each method
 * emits one JSON line (see {@link AppLogLine}) on stdout/stderr.
 *
 * The `console.*` methods are automatically redirected to `Logger`, so
 * `console.log`/`info`/`warn`/`error`/`debug` produce the same structured lines
 * with no code change. Calling `Logger` directly is the explicit, self-
 * documenting form, and does not depend on that redirection being in place.
 */
export interface Logger {
  /** Emit a `debug`-level line on stdout. */
  debug(...args: unknown[]): void
  /** Emit an `info`-level line on stdout. */
  info(...args: unknown[]): void
  /** Emit a `warn`-level line on stderr. */
  warn(...args: unknown[]): void
  /** Emit an `error`-level line on stderr. */
  error(...args: unknown[]): void
}

/**
 * The SDK's {@link Logger}, and the preferred entry point for app logging.
 * Import it and call a level method:
 *
 * ```ts
 * import { Logger } from "@collegevine/trellis-app-sdk"
 * ```
 *
 * Emission is gated by the app's configured log level, which the platform sets:
 * a line is emitted only when its level is at or above the threshold, and by
 * default only `info` and above are emitted. A `debug` line may therefore not
 * appear until the level is lowered.
 *
 * Every emitted line also carries platform-stamped fields — a `timestamp`, the
 * `requestId` of the serving invocation, and the `deploymentId` the app was
 * built from (see {@link AppLogLine}). The examples below omit these to keep the
 * focus on how call arguments map onto `message` and `params`.
 *
 * A leading string argument becomes the line's `message`, and anything after it
 * becomes `params`:
 *
 * ```ts
 * Logger.info("checkout complete")
 * // → {"level":"info","message":"checkout complete"}
 *
 * Logger.info("order placed", { orderId: 7 }, "gift")
 * // → {"level":"info","message":"order placed","params":[{"orderId":7},"gift"]}
 * ```
 *
 * When the first argument is not a string there is no `message`, and every
 * argument goes into the `params` array:
 *
 * ```ts
 * Logger.warn(404, { path: "/x-wing" })
 * // → {"level":"warn","params":[404,{"path":"/x-wing"}]}
 * ```
 *
 * A lone hash argument — or a string message followed by a lone hash — is the
 * exception: the hash's fields are spliced directly onto the log line as
 * top-level fields, rather than nested under `params`, so each stays queryable
 * on its own. On a name clash these fields overwrite the built-ins, including
 * `level`:
 *
 * ```ts
 * Logger.error({ code: "E_TIMEOUT", attempt: 3, fatal: true })
 * // → {"level":"error","code":"E_TIMEOUT","attempt":3,"fatal":true}
 *
 * Logger.info("order placed", { orderId: 7 })
 * // → {"level":"info","message":"order placed","orderId":7}
 *
 * Logger.info({ level: "warn", orderId: 7 })
 * // → {"level":"warn","orderId":7}
 * ```
 */
export const Logger: Logger = {
  debug: (...args) => emit("debug", args),
  info: (...args) => emit("info", args),
  warn: (...args) => emit("warn", args),
  error: (...args) => emit("error", args)
}

let consoleOverridden = false

// Redirect the app's console.* methods to Logger, so existing console.log/info/
// warn/error/debug calls emit structured JSON. Idempotent: a second call is a
// no-op that returns a do-nothing restore, so overlapping callers can never
// un-redirect a console another caller still relies on. The returned function
// restores the original methods; production never calls it, tests do.
export function installJsonLogging(): () => void {
  if (consoleOverridden) return () => {}
  consoleOverridden = true

  const original = Object.fromEntries(
    CONSOLE_METHODS.map((method) => [method, console[method]])
  ) as Pick<Console, LogMethod>

  for (const method of CONSOLE_METHODS) {
    const level = LEVEL_BY_CONSOLE_METHOD[method]
    console[method] = (...args: unknown[]) => Logger[level](...args)
  }

  return () => {
    Object.assign(console, original)
    consoleOverridden = false
  }
}

function emit(level: LogLevel, args: unknown[]): void {
  if (LEVEL_SEVERITY[level] < LEVEL_SEVERITY[configuredLevel()]) return

  const stream = STDERR_LEVELS.has(level) ? process.stderr : process.stdout
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    ...provenance(),
    ...logEntry(args)
  }
  stream.write(serialize(entry) + "\n")
}

function provenance(): Record<string, string> {
  const requestId = currentRequestId()
  const deploymentId = process.env[ENV_DEPLOYMENT_ID]
  return {
    ...(requestId ? { requestId } : {}),
    ...(deploymentId ? { deploymentId } : {})
  }
}

function configuredLevel(): LogLevel {
  const value = process.env[ENV_LOG_LEVEL]

  const isLogLevel = (value: string | undefined): value is LogLevel =>
    value != null && Object.hasOwn(LEVEL_SEVERITY, value)

  return isLogLevel(value) ? value : DEFAULT_LOG_LEVEL
}


// Shapes of `args`, in order:
//
//     * If the first parameter is a string, it becomes `message`.
//     * After dropping the message:
//        * If there is exactly one argument left and it is a hash,
//          its fields are spliced onto the line as top-level fields.
//        * Otherwise, all remaining arguments become the `params` array.
//
function logEntry(args: unknown[]): Record<string, unknown> {
  let [first, ...rest] = args
  const result: Record<string, unknown> = {}

  if (typeof first === "string") {
    result.message = first
    args = Array.from(rest)
    first = rest.shift()
  }

  if (rest.length === 0 && isPlainObject(first)) {
    Object.assign(result, first)
  } else if (args.length > 0) {
    result.params = args
  }

  return result
}

// A "hash": a plain key/value object, as opposed to an array, null, or an
// instance of a class such as Date or Error.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function serialize(entry: Record<string, unknown>): string {
  try {
    return JSON.stringify(entry, circularSafeReplacer())
  } catch {
    return JSON.stringify({
      timestamp: entry.timestamp,
      level: entry.level,
      message: entry.message,
      params: ["[unserializable log arguments]"]
    })
  }
}

// Keeps JSON.stringify from throwing on the two things it cannot handle itself:
// BigInt values and circular references.
function circularSafeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>()
  return (_key, value) => {
    if (typeof value === "bigint") return value.toString()
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]"
      seen.add(value)
    }
    return value
  }
}
