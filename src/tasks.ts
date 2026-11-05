import {
  queryString,
  request,
  requestEnvelope,
  requireAuthenticatedMode,
  withoutUndefined
} from "./http.js"

/** Lifecycle state of a task version. */
export type TaskStatus = "draft" | "active" | "superseded" | "cancelled" | "expired"

/**
 * A segment filter in the Trellis segment filter JSON format. Sent and
 * returned verbatim: the SDK never renames keys inside it.
 */
export type SegmentFilter = Record<string, unknown>

/**
 * Task fields as sent to {@link createTask} and {@link updateTask}. Fields
 * left out are not sent.
 */
export interface TaskFields {
  title?: string
  instructionText?: string
  startTime?: Date
  /** `null` clears the end time. */
  endTime?: Date | null
  additionalFilters?: SegmentFilter
  goalFilters?: SegmentFilter
  /** Sent verbatim. */
  metadata?: Record<string, unknown> | null
}

/** Arguments to {@link createTask}. */
export interface CreateTaskInput extends TaskFields {
  title: string
  instructionText: string
}

/** Display names for ids referenced by a version's filters. */
export interface FilterDisplayNames {
  provenance_names?: Record<string, string>
  property_names?: Record<string, string>
  segment_names?: Record<string, string>
}

/** One version of a task. Null-valued fields are omitted by the API. */
export interface TaskVersion extends FilterDisplayNames {
  task_id?: number
  version_id?: number
  version?: number
  title?: string
  instruction_text?: string
  /** ISO 8601. */
  start_time?: string
  /** ISO 8601. */
  end_time?: string
  additional_filters?: SegmentFilter
  goal_filters?: SegmentFilter
  metadata?: Record<string, unknown>
  status?: TaskStatus
  activation_started_at?: string
  activation_completed_at?: string
  created_at?: string
  updated_at?: string
}

/** A task at the returned version. Null-valued fields are omitted by the API. */
export interface Task extends TaskVersion {
  task_id: number
  is_mission: boolean
  version_id: number
  version: number
  title: string
  instruction_text: string
  status: TaskStatus
  /**
   * Constituents the task reached, or for a draft or not-yet-activated task,
   * would reach.
   */
  constituent_count?: number
  created_at: string
  updated_at: string
}

/** A row of {@link listTasks}. Null-valued fields are omitted by the API. */
export interface TaskSummary {
  task_id: number
  is_mission: boolean
  title?: string
  status?: TaskStatus
  version_count: number
  latest_version?: TaskVersion
  constituent_count?: number
  created_at: string
}

/** Paging for {@link listTasks}. */
export interface ListTasksOptions {
  /** 1–200; the API defaults to 50. */
  limit?: number
  /** The API defaults to 0. */
  offset?: number
}

/** The `meta` of a {@link listTasks} response, as the API sent it. */
export interface TaskListMeta {
  pagination?: { limit: number; offset: number; total: number }
}

/** One page of {@link listTasks}. */
export interface TaskPage {
  items: TaskSummary[]
  meta: TaskListMeta
}

const OPERATION = "Tasks"

/**
 * List one page of an agent's tasks. Server-only. Requires an authenticated
 * deployment and a signed-in operator (an HQ or school user, not a
 * constituent). The agent must be in the App's scope and visible to the
 * operator. Tasks whose filters reference a property the operator cannot read
 * are left out.
 *
 * @param agentId - An agent of the App's school.
 * @param options - `limit` and `offset`.
 * @throws {@link TrellisAppApiError} whose `body.error` is one of:
 * `unauthorized` (401, anonymous deployment or no session), `forbidden` (403,
 * not an operator, no product, agent not accessible), `not_found` (404),
 * `validation_error` (422).
 *
 * @example
 * ```ts
 * const { items, meta } = await listTasks(42, { limit: 50, offset: 0 })
 * console.log(meta.pagination?.total)
 * ```
 */
export async function listTasks(
  agentId: number,
  options: ListTasksOptions = {}
): Promise<TaskPage> {
  requireAuthenticatedMode(OPERATION)
  const { data, meta } = await requestEnvelope<TaskSummary[], TaskListMeta>(
    `${tasksPath(agentId)}${queryString({ limit: options.limit, offset: options.offset })}`
  )
  return { items: data, meta: meta ?? {} }
}

/**
 * Create a draft task for an agent. Server-only. Requires write access.
 * Publish it with {@link publishTask}.
 *
 * @throws {@link TrellisAppApiError} whose `body.error` is one of:
 * `bad_request` (400), `unauthorized` (401), `forbidden` (403), `not_found`
 * (404), `validation_error` (422).
 *
 * @example
 * ```ts
 * const task = await createTask(42, {
 *   title: "FAFSA check-in",
 *   instructionText: "Ask each student whether their FAFSA is submitted.",
 *   startTime: new Date("2026-11-10T14:00:00Z")
 * })
 * ```
 */
export async function createTask(
  agentId: number,
  fields: CreateTaskInput
): Promise<Task> {
  requireAuthenticatedMode(OPERATION)
  return request<Task>(tasksPath(agentId), {
    method: "POST",
    body: taskFieldsBody(fields)
  })
}

/**
 * Get a task at its current version, or at `options.version`. Server-only.
 *
 * @throws {@link TrellisAppApiError} whose `body.error` is one of:
 * `unauthorized` (401), `forbidden` (403), `not_found` (404).
 */
export async function getTask(
  agentId: number,
  taskId: number,
  options: { version?: number } = {}
): Promise<Task> {
  requireAuthenticatedMode(OPERATION)
  return request<Task>(
    `${taskPath(agentId, taskId)}${queryString({ version: options.version })}`
  )
}

/**
 * Change a task, creating a new version. Server-only. Requires write access.
 * Fields left out are unchanged; `endTime: null` clears the end time.
 *
 * @throws {@link TrellisAppApiError} whose `body.error` is one of:
 * `unauthorized` (401), `forbidden` (403), `not_found` (404), `mission_task`
 * (409, the task runs a mission; change it through the Missions functions),
 * `validation_error` (422).
 */
export async function updateTask(
  agentId: number,
  taskId: number,
  fields: TaskFields
): Promise<Task> {
  requireAuthenticatedMode(OPERATION)
  return request<Task>(taskPath(agentId, taskId), {
    method: "PATCH",
    body: taskFieldsBody(fields)
  })
}

/**
 * Publish a task's draft version. Server-only. Requires write access.
 *
 * @throws {@link TrellisAppApiError} whose `body.error` is one of:
 * `unauthorized` (401), `forbidden` (403), `not_found` (404), `mission_task`
 * (409), `validation_error` (422).
 */
export async function publishTask(agentId: number, taskId: number): Promise<Task> {
  requireAuthenticatedMode(OPERATION)
  return request<Task>(`${taskPath(agentId, taskId)}/publish`, { method: "POST" })
}

/**
 * Cancel a task. Server-only. Requires write access.
 *
 * @throws {@link TrellisAppApiError} whose `body.error` is one of:
 * `unauthorized` (401), `forbidden` (403), `not_found` (404), `mission_task`
 * (409), `validation_error` (422).
 */
export async function cancelTask(agentId: number, taskId: number): Promise<Task> {
  requireAuthenticatedMode(OPERATION)
  return request<Task>(`${taskPath(agentId, taskId)}/cancel`, { method: "POST" })
}

function tasksPath(agentId: number): string {
  return `agents/${encodeURIComponent(String(agentId))}/tasks`
}

function taskPath(agentId: number, taskId: number): string {
  return `${tasksPath(agentId)}/${encodeURIComponent(String(taskId))}`
}

function taskFieldsBody(fields: TaskFields): Record<string, unknown> {
  return withoutUndefined({
    title: fields.title,
    instruction_text: fields.instructionText,
    start_time: fields.startTime?.toISOString(),
    end_time:
      fields.endTime === undefined
        ? undefined
        : fields.endTime === null
          ? null
          : fields.endTime.toISOString(),
    additional_filters: fields.additionalFilters,
    goal_filters: fields.goalFilters,
    metadata: fields.metadata
  })
}
