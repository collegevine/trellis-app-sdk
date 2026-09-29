import { request } from "./http.js"

const TINYBIRD_PATH = "tinybird"

/**
 * A Tinybird `DateTime` param, formatted `"YYYY-MM-DD HH:MM:SS"` in UTC, for
 * example `"2026-09-21 05:00:00"`.
 */
export type TinybirdDateTime = string

/**
 * A list with at least one element. Empty lists are rejected because a pipe
 * filtering on an empty list matches nothing and returns zeros rather than an
 * error.
 */
export type NonEmptyList<T> = readonly [T, ...T[]]

/**
 * One `filters` entry. Entries are ANDed together. A `text` filter's
 * `column_key` may be a JSON path, such as `constituent_properties_json.Lead stage`.
 */
export type AgentActivityFilter =
  | {
      type: "text"
      column_key: string
      condition: "equal" | "not-equal" | "contains"
      value: string
    }
  | { type: "text"; column_key: string; condition: "blank" | "present" }
  | { type: "agent-instance"; agent_instance_ids: NonEmptyList<number> }
  | { type: "product"; product_id: string }
  | { type: "task"; task_id: number }

/** Which events to read, shared by `agents__count` and `agents__raw_events`. */
export interface AgentActivityScope {
  /** Event types to include, for example `["email-opened", "send-email"]`. */
  action_or_event_id: NonEmptyList<string>
  /** Inclusive start of the range. */
  date_range_after: TinybirdDateTime
  /** Exclusive end of the range. */
  date_range_before: TinybirdDateTime
  /** Narrow to these agent instances. Omit for every agent in the school. */
  target_agent_instance_ids?: NonEmptyList<number>
  filters?: NonEmptyList<AgentActivityFilter>
}

export type TinybirdIntervalUnit =
  | "hour"
  | "day"
  | "week"
  | "month"
  | "quarter"
  | "year"

/**
 * Params for `agents__count`. Each row is
 * `{ count, aggregated_column, interval_start? }`: one row per
 * `aggregation_column_key` value, times one row per interval when
 * `interval_unit` is set. Empty intervals are filled with `count: 0`.
 */
export type AgentsCountParams = AgentActivityScope & {
  /**
   * `total` counts events. `unique_by_property` counts distinct values of
   * `distinct_column_key`.
   */
  mode: "total" | "unique_by_property"
  /** Column counted by `unique_by_property`. Defaults to `constituent_id`. */
  distinct_column_key?: string
  /**
   * Column to break the count down by, for example `action_or_event_id`.
   * Defaults to `school_id`, which yields a single total.
   */
  aggregation_column_key?: string
} & (
    | {
        interval_unit?: undefined
        /** IANA zone name. Only used with `interval_unit`. */
        timezone?: string
      }
    | {
        /** Return a time series bucketed by this unit. */
        interval_unit: TinybirdIntervalUnit
        /** IANA zone the buckets are aligned to, for example `America/Chicago`. */
        timezone: string
      }
  )

/**
 * Params for `agents__raw_events`: event rows, newest first, one page at a
 * time. Each row holds the `selected_columns` plus `action_class_id`,
 * `action_params_json`, `event_class_id`, and `event_params_json`.
 */
export type AgentsRawEventsParams = AgentActivityScope & {
  /**
   * Columns of the `agent_activity` datasource to return. Include `created_at`
   * to page past the first page.
   */
  selected_columns?: NonEmptyList<string>
  /** Rows per page, up to 32767. */
  page_size: number
  /**
   * Returns rows strictly older than this. For the first page pass
   * `date_range_before`; for each next page pass the last row's `created_at`.
   * A value before `date_range_after` returns no rows.
   */
  last_record_timestamp: TinybirdDateTime
}

/** Params for `agents__field_values`. Each row is `{ value }`. */
export interface AgentsFieldValuesParams {
  /** Column of the `agent_activity` datasource to list distinct values of. */
  column_key: string
  /** Only consider these event types. Note the plural name on this pipe. */
  action_or_event_ids?: NonEmptyList<string>
  /** Only consider events at or after this time. */
  earliest_date?: TinybirdDateTime
  target_agent_instance_ids?: NonEmptyList<number>
  /** Case-insensitive substring match on the value. */
  search_term?: string
  /** Maximum values returned. Defaults to 100. */
  limit?: number
}

/**
 * Params for `agents__constituent_communications`: one constituent's
 * communication events, one page at a time.
 */
export interface AgentsConstituentCommunicationsParams {
  /** Event types to include, for example `["send-sms", "send-email"]`. */
  action_or_event_id: NonEmptyList<string>
  constituent_id: number
  order: "ascending" | "descending"
  /** Rows per page, up to 127. */
  page_size: number
  selected_columns?: NonEmptyList<string>
  target_agent_instance_ids?: NonEmptyList<number>
  /**
   * Cursor: with `descending`, returns rows older than this; with `ascending`,
   * newer. Omit for the first page.
   */
  last_record_timestamp?: TinybirdDateTime
  /** Absolute floor regardless of `order`. */
  earliest_created_at?: TinybirdDateTime
}

type TinybirdParams =
  | AgentsCountParams
  | AgentsRawEventsParams
  | AgentsFieldValuesParams
  | AgentsConstituentCommunicationsParams

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
 * The deployment's school is applied server-side, so do not pass `school_id`.
 * A request the pipe cannot answer correctly fails to compile rather than
 * returning zeros at runtime. Params set to `undefined` are omitted from the
 * request rather than sent as empty strings.
 *
 * @throws {@link TrellisAppApiError} on any non-2xx response.
 *
 * @example
 * Daily email opens for one agent over a week:
 * ```ts
 * const { data } = await queryTinybirdPipe("agents__count", {
 *   mode: "total",
 *   action_or_event_id: ["email-opened"],
 *   target_agent_instance_ids: [25038],
 *   date_range_after: "2026-09-21 05:00:00",
 *   date_range_before: "2026-09-28 05:00:00",
 *   interval_unit: "day",
 *   timezone: "America/Chicago"
 * })
 * ```
 */
export function queryTinybirdPipe<TRow = Record<string, unknown>>(
  pipe: "agents__count",
  params: AgentsCountParams
): Promise<TinybirdResponse<TRow>>
export function queryTinybirdPipe<TRow = Record<string, unknown>>(
  pipe: "agents__raw_events",
  params: AgentsRawEventsParams
): Promise<TinybirdResponse<TRow>>
export function queryTinybirdPipe<TRow = Record<string, unknown>>(
  pipe: "agents__field_values",
  params: AgentsFieldValuesParams
): Promise<TinybirdResponse<TRow>>
export function queryTinybirdPipe<TRow = Record<string, unknown>>(
  pipe: "agents__constituent_communications",
  params: AgentsConstituentCommunicationsParams
): Promise<TinybirdResponse<TRow>>
export async function queryTinybirdPipe<TRow = Record<string, unknown>>(
  pipe: string,
  params: TinybirdParams
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
    // Callers written against the earlier untyped params may still pass null.
    if (value === null || value === undefined) continue
    search.append(key, serializeParam(value))
  }
  return search.toString()
}

// Tinybird Array() params are comma-separated; JSON() params (`filters`) are JSON.
function serializeParam(value: unknown): string {
  if (!Array.isArray(value)) return String(value)
  if (value.some((item) => typeof item === "object")) return JSON.stringify(value)
  return value.join(",")
}
