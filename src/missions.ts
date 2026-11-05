import {
  queryString,
  request,
  requestEnvelope,
  requireAuthenticatedMode,
  withoutUndefined
} from "./http.js"

/** `workflow` missions live under `/missions/{id}`, `task` missions under `/missions/tasks/{id}`. */
export type MissionKind = "workflow" | "task"
/** A tab of the missions list. */
export type MissionTab = "active" | "paused" | "drafts" | "completed"
export type MissionChannel = "email" | "sms" | "phone"
export type MissionState =
  | "draft"
  | "launching"
  | "live"
  | "paused"
  | "finished"
  | "approval_pending"
  | "approval_denied"

/** A mission goal condition, as sent. */
export interface GoalFilterInput {
  type: "string_match" | "contains_match" | "null_match"
  propertyKey: string
  /**
   * `string_match`: a non-empty list of strings. `contains_match`: a
   * non-empty string. `null_match`: ignored.
   */
  value?: string[] | string
  negate?: boolean
}

/** A mission goal condition, as returned. */
export interface GoalFilter {
  type: "string_match" | "contains_match" | "null_match"
  property_key: string
  value?: string[] | string
  negate?: boolean
}

/** Workflow mission fields as sent. Fields left out are not sent. */
export interface WorkflowMissionFields {
  /** May be sent on update, but must equal the mission's channel. */
  channel?: MissionChannel
  name?: string
  instructions?: string
  segmentUid?: string
  goalFilters?: GoalFilterInput[]
  /** An id from {@link getMissionOptions} for the mission's channel. */
  senderId?: number | string
  /** 1–14. */
  maxSends?: number | string
  /** 1–14. */
  minDaysApart?: number | string
  /** `YYYY-MM-DD`, after today. `null` clears it. */
  endsAt?: string | null
  /** Email and phone only. An http(s) URL, or `""` to clear it. */
  ctaUrl?: string
  /** Email and phone only. */
  ctaText?: string
}

/** Arguments to {@link createWorkflowMission}. */
export interface CreateWorkflowMissionInput extends WorkflowMissionFields {
  channel: MissionChannel
  name: string
  instructions: string
  segmentUid: string
  /** A team the App may assign, so the App keeps seeing the mission it created. */
  permissionGroupId: number | string
}

/** Task mission fields as sent. Fields left out are not sent. */
export interface TaskMissionFields {
  /** An id from `host_agents` in {@link getMissionOptions}. */
  hostAgentId?: number | string
  name?: string
  instructions?: string
  segmentUid?: string
  /** At most one. */
  goalFilters?: GoalFilterInput[]
  /** `YYYY-MM-DD`, after today. `null` clears it. */
  endsAt?: string | null
}

/** Arguments to {@link createTaskMission}. */
export interface CreateTaskMissionInput extends TaskMissionFields {
  hostAgentId: number | string
  name: string
  instructions: string
  segmentUid: string
}

/** A mission in a list, or after a state change. */
export interface MissionSummary {
  kind: MissionKind
  id: number
  name: string
  channel: MissionChannel | null
  status: MissionState
  launched_at: string | null
  /** `YYYY-MM-DD`. */
  ends_at: string | null
  paused_at: string | null
  edited_at: string | null
  created_by: string | null
}

export interface SegmentRef {
  uid: string
  name: string
}

export interface NamedRef {
  id: number
  name: string
}

export interface WorkflowMissionDetail extends MissionSummary {
  kind: "workflow"
  instructions: string | null
  segment: SegmentRef | null
  /** `null` when the stored goal cannot be expressed as goal filters. */
  goal_filters: GoalFilter[] | null
  goal_filters_unreadable: boolean
  sender_id: number | null
  max_sends: number | null
  min_days_apart: number | null
  cta_url?: string | null
  cta_text?: string | null
}

export interface TaskMissionDetail extends MissionSummary {
  kind: "task"
  instructions: string | null
  segment: SegmentRef | null
  host_agent: NamedRef
  goal_filters: GoalFilter[] | null
  goal_filters_unreadable: boolean
}

/** Filters and paging for {@link listMissions}. */
export interface ListMissionsOptions {
  /** Without a tab, every tab is searched. */
  tab?: MissionTab
  kind?: MissionKind
  channel?: MissionChannel
  /** Name search. */
  query?: string
  /** 1–100; the API defaults to 1. */
  page?: number
  /** 1–50; the API defaults to 25. */
  perPage?: number
}

/** The `meta` of a {@link listMissions} response, as the API sent it. */
export interface MissionListMeta {
  page: number
  per_page: number
  has_more: boolean
  /** Mission count per tab. */
  counts?: Partial<Record<MissionTab, number>> & Record<string, number>
}

/** One page of {@link listMissions}. */
export interface MissionPage {
  items: MissionSummary[]
  meta: MissionListMeta
}

export interface SenderOption {
  id: number
  label: string
  /** Null when the channel does not route replies. */
  answers_replies?: boolean | null
}

/** Result of {@link getMissionOptions}. */
export interface MissionOptions {
  senders: Partial<Record<MissionChannel, SenderOption[]>>
  /** Present only when task missions are enabled. */
  host_agents?: NamedRef[]
}

/** Result of launching a mission. The API answers 202 for `pending_approval`. */
export interface MissionLaunch {
  mission: MissionSummary
  launch: "started" | "pending_approval" | "already_running"
}

/** What blocks a mission from launching. Empty means it can launch. */
export interface MissionLaunchCheck {
  problems: string[]
}

/** The mission after a state change. */
export interface MissionChange {
  mission: MissionSummary
}

const OPERATION = "Missions"

// The API's mission errors, for the doc comments below:
//   403 `forbidden`, `insufficient_platform_role`, `no_school_user`,
//       `launch_denied`, `mission_managed`
//   409 `not_editable`, `audience_locked`, `not_launchable`, `not_pausable`,
//       `not_cancellable`, `not_deletable`
//   422 `validation_error`, `unreadable_goal`, `launch_blocked`,
//       `missing_sender`, `past_shutoff`, `unsupported_mission`
//   503 `blueprint_unavailable`, `approval_check_failed`, `service_unavailable`

/**
 * List one page of missions in the App agent's product. Server-only.
 *
 * All mission functions require an authenticated deployment, a signed-in
 * operator (not a constituent) with the platform role `tester` to read or
 * `user` to write, an App whose agent has a product, and missions enabled for
 * the school and operator. Multichannel missions are not listed, and the
 * per-mission functions return 422 `unsupported_mission` for them.
 *
 * @throws {@link TrellisAppApiError} with status 401, 403, 422 or 503.
 *
 * @example
 * ```ts
 * const { items, meta } = await listMissions({ tab: "active", perPage: 10 })
 * if (meta.has_more) { ... }
 * ```
 */
export async function listMissions(
  options: ListMissionsOptions = {}
): Promise<MissionPage> {
  requireAuthenticatedMode(OPERATION)
  const query = queryString({
    tab: options.tab,
    kind: options.kind,
    channel: options.channel,
    query: options.query,
    page: options.page,
    per_page: options.perPage
  })
  const { data, meta } = await requestEnvelope<MissionSummary[], MissionListMeta>(
    `missions${query}`
  )
  return { items: data, meta }
}

/**
 * List the senders per channel, and the host agents for task missions, that a
 * new mission may use. Server-only.
 *
 * @throws {@link TrellisAppApiError} with status 401 or 403.
 */
export async function getMissionOptions(): Promise<MissionOptions> {
  requireAuthenticatedMode(OPERATION)
  return request<MissionOptions>("missions/options")
}

/**
 * Create a draft workflow mission. Server-only.
 *
 * @throws {@link TrellisAppApiError} with status 401, 403, 404 (`not_found`:
 * segment or permission group not assignable), 422 or 503.
 *
 * @example
 * ```ts
 * const mission = await createWorkflowMission({
 *   channel: "email",
 *   name: "Deposit nudge",
 *   instructions: "Remind admitted students the deposit is due.",
 *   segmentUid: "seg_admitted_fall_2027",
 *   permissionGroupId: 501,
 *   goalFilters: [{ type: "string_match", propertyKey: "deposit_status", value: ["paid"] }]
 * })
 * ```
 */
export async function createWorkflowMission(
  input: CreateWorkflowMissionInput
): Promise<WorkflowMissionDetail> {
  requireAuthenticatedMode(OPERATION)
  return request<WorkflowMissionDetail>("missions", {
    method: "POST",
    body: {
      kind: "workflow",
      ...workflowFieldsBody(input),
      permission_group_id: input.permissionGroupId
    }
  })
}

/**
 * Create a draft task mission. Server-only. Requires the school's
 * task-missions flag (403 `forbidden` otherwise).
 *
 * @throws {@link TrellisAppApiError} with status 401, 403, 404, 422 or 503.
 */
export async function createTaskMission(
  input: CreateTaskMissionInput
): Promise<TaskMissionDetail> {
  requireAuthenticatedMode(OPERATION)
  return request<TaskMissionDetail>("missions", {
    method: "POST",
    body: { kind: "task", ...taskMissionFieldsBody(input) }
  })
}

/**
 * Get a workflow mission. Server-only.
 *
 * @throws {@link TrellisAppApiError} with status 401, 403, 404 or 422.
 */
export async function getWorkflowMission(id: number): Promise<WorkflowMissionDetail> {
  requireAuthenticatedMode(OPERATION)
  return request<WorkflowMissionDetail>(workflowPath(id))
}

/**
 * Change a workflow mission. Server-only. Send at least one field; fields
 * left out are unchanged.
 *
 * @throws {@link TrellisAppApiError} with status 401, 403, 404, 409 or 422.
 */
export async function updateWorkflowMission(
  id: number,
  fields: WorkflowMissionFields
): Promise<WorkflowMissionDetail> {
  requireAuthenticatedMode(OPERATION)
  return request<WorkflowMissionDetail>(workflowPath(id), {
    method: "PATCH",
    body: workflowFieldsBody(fields)
  })
}

/**
 * Delete a workflow mission. Server-only. Returns its summary, without
 * `status`.
 *
 * @throws {@link TrellisAppApiError} with status 401, 403, 404, 409 or 422.
 */
export async function deleteWorkflowMission(
  id: number
): Promise<{ mission: Omit<MissionSummary, "status"> }> {
  requireAuthenticatedMode(OPERATION)
  return request<{ mission: Omit<MissionSummary, "status"> }>(workflowPath(id), {
    method: "DELETE"
  })
}

/**
 * List what blocks a workflow mission from launching. Server-only.
 *
 * @throws {@link TrellisAppApiError} with status 401, 403, 404 or 422.
 */
export async function checkWorkflowMissionLaunch(id: number): Promise<MissionLaunchCheck> {
  requireAuthenticatedMode(OPERATION)
  return request<MissionLaunchCheck>(`${workflowPath(id)}/launch_check`)
}

/**
 * Launch a workflow mission, or resume a paused one. Server-only. The
 * operator must be HQ or a user of the school. When launch needs approval
 * this resolves with `launch: "pending_approval"`; it does not throw.
 *
 * @throws {@link TrellisAppApiError} with status 401, 403, 404, 409, 422 or 503.
 */
export async function launchWorkflowMission(id: number): Promise<MissionLaunch> {
  requireAuthenticatedMode(OPERATION)
  return request<MissionLaunch>(`${workflowPath(id)}/launch`, { method: "POST" })
}

/**
 * Pause a workflow mission. Server-only. A mission already paused or finished
 * is returned unchanged.
 *
 * @throws {@link TrellisAppApiError} with status 401, 403, 404, 409 or 422.
 */
export async function pauseWorkflowMission(id: number): Promise<MissionChange> {
  requireAuthenticatedMode(OPERATION)
  return request<MissionChange>(`${workflowPath(id)}/pause`, { method: "POST" })
}

/**
 * Get a task mission. Server-only.
 *
 * @throws {@link TrellisAppApiError} with status 401, 403, 404 or 422.
 */
export async function getTaskMission(id: number): Promise<TaskMissionDetail> {
  requireAuthenticatedMode(OPERATION)
  return request<TaskMissionDetail>(taskMissionPath(id))
}

/**
 * Change a task mission. Server-only. Send at least one field; fields left
 * out are unchanged.
 *
 * @throws {@link TrellisAppApiError} with status 401, 403, 404, 409 or 422.
 */
export async function updateTaskMission(
  id: number,
  fields: TaskMissionFields
): Promise<TaskMissionDetail> {
  requireAuthenticatedMode(OPERATION)
  return request<TaskMissionDetail>(taskMissionPath(id), {
    method: "PATCH",
    body: taskMissionFieldsBody(fields)
  })
}

/**
 * List what blocks a task mission from launching. Server-only.
 *
 * @throws {@link TrellisAppApiError} with status 401, 403, 404 or 422.
 */
export async function checkTaskMissionLaunch(id: number): Promise<MissionLaunchCheck> {
  requireAuthenticatedMode(OPERATION)
  return request<MissionLaunchCheck>(`${taskMissionPath(id)}/launch_check`)
}

/**
 * Launch a draft task mission. Server-only. A launching or live mission
 * resolves with `launch: "already_running"`; pending-approval, paused-host and
 * finished missions throw 409 `not_launchable`.
 *
 * @throws {@link TrellisAppApiError} with status 401, 403, 404, 409, 422 or 503.
 */
export async function launchTaskMission(id: number): Promise<MissionLaunch> {
  requireAuthenticatedMode(OPERATION)
  return request<MissionLaunch>(`${taskMissionPath(id)}/launch`, { method: "POST" })
}

/**
 * Cancel a task mission. Server-only.
 *
 * @throws {@link TrellisAppApiError} with status 401, 403, 404, 409 or 422.
 */
export async function cancelTaskMission(id: number): Promise<MissionChange> {
  requireAuthenticatedMode(OPERATION)
  return request<MissionChange>(`${taskMissionPath(id)}/cancel`, { method: "POST" })
}

function workflowPath(id: number): string {
  return `missions/${encodeURIComponent(String(id))}`
}

function taskMissionPath(id: number): string {
  return `missions/tasks/${encodeURIComponent(String(id))}`
}

function workflowFieldsBody(fields: WorkflowMissionFields): Record<string, unknown> {
  return withoutUndefined({
    channel: fields.channel,
    name: fields.name,
    instructions: fields.instructions,
    segment_uid: fields.segmentUid,
    goal_filters: goalFiltersBody(fields.goalFilters),
    sender_id: fields.senderId,
    max_sends: fields.maxSends,
    min_days_apart: fields.minDaysApart,
    ends_at: fields.endsAt,
    cta_url: fields.ctaUrl,
    cta_text: fields.ctaText
  })
}

function taskMissionFieldsBody(fields: TaskMissionFields): Record<string, unknown> {
  return withoutUndefined({
    host_agent_id: fields.hostAgentId,
    name: fields.name,
    instructions: fields.instructions,
    segment_uid: fields.segmentUid,
    goal_filters: goalFiltersBody(fields.goalFilters),
    ends_at: fields.endsAt
  })
}

function goalFiltersBody(filters: GoalFilterInput[] | undefined): unknown {
  return filters?.map((filter) =>
    withoutUndefined({
      type: filter.type,
      property_key: filter.propertyKey,
      value: filter.value,
      negate: filter.negate
    })
  )
}
