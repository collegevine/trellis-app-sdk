// Debug instrumentation for the app's Trellis App API calls: wraps the `fetch`
// every SDK call goes through to emit a log line for each one.

import { type AppLogLine, Logger } from "./logging.js"

const API_CALL_MESSAGE = "API call"

// Max length of a logged failure message, above which we truncate to avoid
// bloating the logs.
const MAX_ERROR_LENGTH = 500

/**
 * The shape of the `debug`-level line emitted for every Trellis App API call
 * the SDK makes on the app's behalf — a data-source query, an LLM inference, an
 * upload ticket, the OAuth token exchange. It is an {@link AppLogLine} whose
 * `message` is `"API call"`, with the call's details spliced on as top-level
 * fields so each is queryable on its own in CloudWatch. You never construct
 * this; it documents what an SDK call produces in the logs.
 *
 * One line is emitted per call, once the call has settled, so its `durationMs`
 * covers the whole round trip. A call the API answered carries `status`,
 * whatever that status is: a failed call is logged the same way a successful
 * one is, with its error status. A call that never reached the API — a
 * connection reset, a DNS failure — carries `error` instead of `status`.
 *
 * Neither the request nor the response body is logged for fear of privacy
 * violations or logs bloat.
 */
export interface ApiCallLog extends AppLogLine {
  /** Always `"API call"`. */
  message: "API call"

  /** The API endpoint's path, without the query string. */
  path: string

  /** The HTTP method of the call. */
  method: string

  /**
   * The query string with its leading `?` stripped, present only when the call
   * had one.
   */
  query?: string

  /**
   * The HTTP status the API answered with. Omitted when the request never
   * produced a response, in which case `error` says why.
   */
  status?: number

  /**
   * Why the request never produced a response, truncated with a trailing `"…"`
   * past ~500 characters. Present only for a call that failed to reach the API;
   * a call the API answered carries a `status` instead.
   */
  error?: string

  /** How long, in milliseconds, the call took to settle. */
  durationMs: number
}

// Every Trellis App API call the SDK makes passes through here, which is what
// lets one wrapper log all of them. The call itself is untouched: the response
// is returned and a failure rethrown exactly as `fetch` produced it, so logging
// can never change what the caller sees.
export async function loggedApiFetch(url: string, init: RequestInit): Promise<Response> {
  const startedAt = Date.now()

  try {
    const response = await fetch(url, init)
    safeEmit(url, init, startedAt, { status: response.status })
    return response
  } catch (failure) {
    safeEmit(url, init, startedAt, { error: failureMessage(failure) })
    throw failure
  }
}

function safeEmit(
  url: string,
  init: RequestInit,
  startedAt: number,
  outcome: { status: number } | { error: string }
): void {
  try {
    Logger.debug(API_CALL_MESSAGE, {
      ...callFields(url, init),
      ...outcome,
      durationMs: Date.now() - startedAt
    } satisfies Pick<
      ApiCallLog,
      "path" | "method" | "query" | "status" | "error" | "durationMs"
    >)
  } catch {
    // Swallow errors. If we failed to log, that's not worth failing the call.
  }
}

function callFields(
  url: string,
  init: RequestInit
): Pick<ApiCallLog, "path" | "method" | "query"> {
  const { pathname, search } = new URL(url)
  return {
    path: pathname,
    method: init.method ?? "GET",
    ...(search ? { query: search.slice(1) } : {})
  }
}

function failureMessage(failure: unknown): string {
  const message = failure instanceof Error ? failure.message : String(failure)
  return message.length <= MAX_ERROR_LENGTH
    ? message
    : `${message.slice(0, MAX_ERROR_LENGTH)}…`
}
