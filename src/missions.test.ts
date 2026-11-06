import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cancelTaskMission,
  checkTaskMissionLaunch,
  checkWorkflowMissionLaunch,
  createTaskMission,
  createWorkflowMission,
  deleteWorkflowMission,
  getMissionOptions,
  getTaskMission,
  getWorkflowMission,
  launchTaskMission,
  launchWorkflowMission,
  listMissions,
  pauseWorkflowMission,
  TrellisAppApiError,
  updateTaskMission,
  updateWorkflowMission
} from "../src/index.js"
import {
  SESSION_COOKIE,
  type SessionCookie,
  type SubjectType
} from "./auth/cookies.js"
import { runWithRequest } from "./context.js"
import { signedCookieHeader } from "./cookies.js"

const BASE_URL = "https://api.example.com/trellis/apps/api/v1/"
const SECRET = "tas_speak-friend-and-enter"
const ACCESS_TOKEN = "tau_signed-in-operator"
const MISSION_ID = 7

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  process.env.TRELLIS_APP_API_URL = BASE_URL
  process.env.TRELLIS_APP_API_SECRET = SECRET
  process.env.TRELLIS_APP_AUTH_MODE = "authenticated"
  fetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.TRELLIS_APP_API_URL
  delete process.env.TRELLIS_APP_API_SECRET
  delete process.env.TRELLIS_APP_AUTH_MODE
})

describe("listMissions", () => {
  it("GETs every tab with the session token and returns the rows with the raw meta", async () => {
    const summaries = [missionSummary(), missionSummary({ kind: "task", id: 3, channel: null })]
    const meta = {
      page: 1,
      per_page: 25,
      has_more: true,
      counts: { active: 4, paused: 1, drafts: 2, completed: 9 }
    }
    fetchMock.mockResolvedValue(jsonResponse(200, { data: summaries, meta }))

    const result = await withSession("school_user", () => listMissions())

    expect(result).toEqual({ items: summaries, meta })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}missions`)
    expect(init.method).toBe("GET")
    expect(init.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(init.body).toBeUndefined()
  })

  it("maps filters and paging to snake_case query parameters, omitting those not given", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(200, { data: [], meta: { page: 2, per_page: 10, has_more: false } })
      )
    )

    await withSession("school_user", () =>
      listMissions({
        tab: "active",
        kind: "workflow",
        channel: "email",
        query: "melt & yield",
        page: 2,
        perPage: 10
      })
    )
    await withSession("school_user", () => listMissions({ tab: "drafts" }))

    const full = new URL(fetchMock.mock.calls[0]![0])
    expect(Object.fromEntries(full.searchParams)).toEqual({
      tab: "active",
      kind: "workflow",
      channel: "email",
      query: "melt & yield",
      page: "2",
      per_page: "10"
    })
    const partial = new URL(fetchMock.mock.calls[1]![0])
    expect(Object.fromEntries(partial.searchParams)).toEqual({ tab: "drafts" })
  })
})

describe("getMissionOptions", () => {
  it("GETs the senders and host agents a mission may use", async () => {
    const options = {
      senders: {
        email: [{ id: 11, label: "Admissions <admissions@arrakis.edu>", answers_replies: true }],
        sms: [{ id: 12, label: "+1 555 0100", answers_replies: null }]
      },
      host_agents: [{ id: 42, name: "Recruiter" }]
    }
    fetchMock.mockResolvedValue(jsonResponse(200, { data: options }))

    const result = await withSession("school_user", () => getMissionOptions())

    expect(result).toEqual(options)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}missions/options`)
    expect(init.method).toBe("GET")
  })
})

describe("createWorkflowMission", () => {
  it("POSTs kind workflow with camelCase fields mapped to snake_case and returns the draft", async () => {
    const detail = workflowMissionDetail()
    fetchMock.mockResolvedValue(jsonResponse(201, { data: detail }))

    const result = await withSession("school_user", () =>
      createWorkflowMission({
        channel: "email",
        name: "Deposit nudge",
        instructions: "Remind admitted students the deposit is due.",
        segmentUid: "seg_admitted_fall_2027",
        permissionGroupId: 501,
        goalFilters: [
          { type: "string_match", propertyKey: "deposit_status", value: ["paid"] },
          { type: "null_match", propertyKey: "withdrawn_at", negate: true }
        ],
        senderId: 11,
        maxSends: 3,
        minDaysApart: 2,
        endsAt: "2026-12-15",
        ctaUrl: "https://arrakis.edu/deposit",
        ctaText: "Pay deposit"
      })
    )

    expect(result).toEqual(detail)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}missions`)
    expect(init.method).toBe("POST")
    expect(init.headers["Content-Type"]).toBe("application/json")
    expect(JSON.parse(init.body as string)).toEqual({
      kind: "workflow",
      channel: "email",
      name: "Deposit nudge",
      instructions: "Remind admitted students the deposit is due.",
      segment_uid: "seg_admitted_fall_2027",
      permission_group_id: 501,
      goal_filters: [
        { type: "string_match", property_key: "deposit_status", value: ["paid"] },
        { type: "null_match", property_key: "withdrawn_at", negate: true }
      ],
      sender_id: 11,
      max_sends: 3,
      min_days_apart: 2,
      ends_at: "2026-12-15",
      cta_url: "https://arrakis.edu/deposit",
      cta_text: "Pay deposit"
    })
  })

  it("sends only the required fields when no optional ones are given", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { data: workflowMissionDetail() }))

    await withSession("school_user", () =>
      createWorkflowMission({
        channel: "sms",
        name: "Minimal",
        instructions: "Say hello.",
        segmentUid: "seg_1",
        permissionGroupId: "team-7"
      })
    )

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body).toEqual({
      kind: "workflow",
      channel: "sms",
      name: "Minimal",
      instructions: "Say hello.",
      segment_uid: "seg_1",
      permission_group_id: "team-7"
    })
  })
})

describe("request bodies are built from named inputs only", () => {
  it("does not forward keys the input type does not declare, such as a foreign product id", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(201, { data: workflowMissionDetail() }))
    )
    const smuggled = {
      channel: "email",
      name: "Smuggled",
      instructions: "i",
      segmentUid: "seg_1",
      permissionGroupId: 4,
      productId: 999,
      product_id: 999
    } as unknown as Parameters<typeof createWorkflowMission>[0]

    await withSession("school_user", () => createWorkflowMission(smuggled))
    await withSession("school_user", () =>
      updateWorkflowMission(MISSION_ID, smuggled as Parameters<typeof updateWorkflowMission>[1])
    )

    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse(init.body as string)
      expect(body).not.toHaveProperty("product_id")
      expect(body).not.toHaveProperty("productId")
    }
  })
})

describe("createTaskMission", () => {
  it("POSTs kind task with camelCase fields mapped to snake_case and returns the draft", async () => {
    const detail = taskMissionDetail()
    fetchMock.mockResolvedValue(jsonResponse(201, { data: detail }))

    const result = await withSession("school_user", () =>
      createTaskMission({
        hostAgentId: 42,
        name: "Transcript chase",
        instructions: "Ask for the final transcript.",
        segmentUid: "seg_missing_transcripts",
        goalFilters: [{ type: "contains_match", propertyKey: "transcript_status", value: "received" }],
        endsAt: "2027-01-31"
      })
    )

    expect(result).toEqual(detail)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}missions`)
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body as string)).toEqual({
      kind: "task",
      host_agent_id: 42,
      name: "Transcript chase",
      instructions: "Ask for the final transcript.",
      segment_uid: "seg_missing_transcripts",
      goal_filters: [
        { type: "contains_match", property_key: "transcript_status", value: "received" }
      ],
      ends_at: "2027-01-31"
    })
  })
})

describe("workflow missions", () => {
  it("getWorkflowMission GETs /missions/{id}", async () => {
    const detail = workflowMissionDetail()
    fetchMock.mockResolvedValue(jsonResponse(200, { data: detail }))

    const result = await withSession("school_user", () => getWorkflowMission(MISSION_ID))

    expect(result).toEqual(detail)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}missions/7`)
    expect(init.method).toBe("GET")
  })

  it("updateWorkflowMission PATCHes only the given fields, mapped to snake_case", async () => {
    const detail = workflowMissionDetail({ name: "Renamed" })
    fetchMock.mockResolvedValue(jsonResponse(200, { data: detail }))

    const result = await withSession("school_user", () =>
      updateWorkflowMission(MISSION_ID, { name: "Renamed", maxSends: 5 })
    )

    expect(result).toEqual(detail)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}missions/7`)
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(init.body as string)).toEqual({ name: "Renamed", max_sends: 5 })
  })

  it("updateWorkflowMission sends ends_at: null and an empty cta_url to clear them", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: workflowMissionDetail() }))

    await withSession("school_user", () =>
      updateWorkflowMission(MISSION_ID, { endsAt: null, ctaUrl: "" })
    )

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body).toEqual({ ends_at: null, cta_url: "" })
  })

  it("deleteWorkflowMission DELETEs /missions/{id} and returns the deleted summary", async () => {
    const { status: _status, ...deleted } = missionSummary()
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { mission: deleted } }))

    const result = await withSession("school_user", () => deleteWorkflowMission(MISSION_ID))

    expect(result).toEqual({ mission: deleted })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}missions/7`)
    expect(init.method).toBe("DELETE")
  })

  it("checkWorkflowMissionLaunch GETs /missions/{id}/launch_check and returns the problems", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: { problems: ["missing_sender"] } })
    )

    const result = await withSession("school_user", () =>
      checkWorkflowMissionLaunch(MISSION_ID)
    )

    expect(result).toEqual({ problems: ["missing_sender"] })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}missions/7/launch_check`)
    expect(init.method).toBe("GET")
  })

  it("launchWorkflowMission POSTs /missions/{id}/launch and returns the launch outcome", async () => {
    const launched = { mission: missionSummary({ status: "launching" }), launch: "started" }
    fetchMock.mockResolvedValue(jsonResponse(200, { data: launched }))

    const result = await withSession("school_user", () => launchWorkflowMission(MISSION_ID))

    expect(result).toEqual(launched)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}missions/7/launch`)
    expect(init.method).toBe("POST")
    expect(init.body).toBeUndefined()
  })

  it("launchWorkflowMission resolves, rather than throws, on 202 pending_approval", async () => {
    const pending = {
      mission: missionSummary({ status: "approval_pending" }),
      launch: "pending_approval"
    }
    fetchMock.mockResolvedValue(jsonResponse(202, { data: pending }))

    const result = await withSession("school_user", () => launchWorkflowMission(MISSION_ID))

    expect(result).toEqual(pending)
  })

  it("pauseWorkflowMission POSTs /missions/{id}/pause and returns the summary", async () => {
    const paused = { mission: missionSummary({ status: "paused" }) }
    fetchMock.mockResolvedValue(jsonResponse(200, { data: paused }))

    const result = await withSession("school_user", () => pauseWorkflowMission(MISSION_ID))

    expect(result).toEqual(paused)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}missions/7/pause`)
    expect(init.method).toBe("POST")
  })
})

describe("task missions", () => {
  it("getTaskMission GETs /missions/tasks/{id}, never the workflow path", async () => {
    const detail = taskMissionDetail()
    fetchMock.mockResolvedValue(jsonResponse(200, { data: detail }))

    const result = await withSession("school_user", () => getTaskMission(MISSION_ID))

    expect(result).toEqual(detail)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}missions/tasks/7`)
    expect(init.method).toBe("GET")
  })

  it("updateTaskMission PATCHes only the given fields, mapped to snake_case", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: taskMissionDetail() }))

    await withSession("school_user", () =>
      updateTaskMission(MISSION_ID, { hostAgentId: "43", endsAt: null })
    )

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}missions/tasks/7`)
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(init.body as string)).toEqual({ host_agent_id: "43", ends_at: null })
  })

  it("checkTaskMissionLaunch GETs /missions/tasks/{id}/launch_check", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { problems: [] } }))

    const result = await withSession("school_user", () => checkTaskMissionLaunch(MISSION_ID))

    expect(result).toEqual({ problems: [] })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}missions/tasks/7/launch_check`)
    expect(init.method).toBe("GET")
  })

  it("launchTaskMission POSTs /missions/tasks/{id}/launch and returns already_running unchanged", async () => {
    const running = {
      mission: missionSummary({ kind: "task", status: "live", channel: null }),
      launch: "already_running"
    }
    fetchMock.mockResolvedValue(jsonResponse(200, { data: running }))

    const result = await withSession("school_user", () => launchTaskMission(MISSION_ID))

    expect(result).toEqual(running)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}missions/tasks/7/launch`)
    expect(init.method).toBe("POST")
  })

  it("cancelTaskMission POSTs /missions/tasks/{id}/cancel and returns the summary", async () => {
    const cancelled = { mission: missionSummary({ kind: "task", status: "finished", channel: null }) }
    fetchMock.mockResolvedValue(jsonResponse(200, { data: cancelled }))

    const result = await withSession("school_user", () => cancelTaskMission(MISSION_ID))

    expect(result).toEqual(cancelled)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}missions/tasks/7/cancel`)
    expect(init.method).toBe("POST")
  })
})

describe("session requirements", () => {
  const calls: [string, () => Promise<unknown>][] = [
    ["listMissions", () => listMissions()],
    ["getMissionOptions", () => getMissionOptions()],
    [
      "createWorkflowMission",
      () =>
        createWorkflowMission({
          channel: "email",
          name: "n",
          instructions: "i",
          segmentUid: "s",
          permissionGroupId: 1
        })
    ],
    [
      "createTaskMission",
      () =>
        createTaskMission({ hostAgentId: 1, name: "n", instructions: "i", segmentUid: "s" })
    ],
    ["getWorkflowMission", () => getWorkflowMission(MISSION_ID)],
    ["updateWorkflowMission", () => updateWorkflowMission(MISSION_ID, { name: "n" })],
    ["deleteWorkflowMission", () => deleteWorkflowMission(MISSION_ID)],
    ["checkWorkflowMissionLaunch", () => checkWorkflowMissionLaunch(MISSION_ID)],
    ["launchWorkflowMission", () => launchWorkflowMission(MISSION_ID)],
    ["pauseWorkflowMission", () => pauseWorkflowMission(MISSION_ID)],
    ["getTaskMission", () => getTaskMission(MISSION_ID)],
    ["updateTaskMission", () => updateTaskMission(MISSION_ID, { name: "n" })],
    ["checkTaskMissionLaunch", () => checkTaskMissionLaunch(MISSION_ID)],
    ["launchTaskMission", () => launchTaskMission(MISSION_ID)],
    ["cancelTaskMission", () => cancelTaskMission(MISSION_ID)]
  ]

  it.each(calls)(
    "%s rejects an anonymous deployment without sending its deployment secret",
    async (_name, call) => {
      process.env.TRELLIS_APP_AUTH_MODE = "anonymous"

      const error = await captureError(() => withSession("school_user", call))

      expect(error).toBeInstanceOf(TrellisAppApiError)
      expect(error).toMatchObject({ status: 401, body: { error: "unauthorized" } })
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

  it.each(calls)(
    "%s throws 401 without calling the API when there is no session cookie",
    async (_name, call) => {
      const error = await captureError(() =>
        runWithRequest({ request: new Request("https://app.example.com/") }, call)
      )

      expect(error).toBeInstanceOf(TrellisAppApiError)
      expect((error as TrellisAppApiError).status).toBe(401)
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )
})

describe("API errors", () => {
  const cases: [number, string, () => Promise<unknown>][] = [
    [403, "insufficient_platform_role", () => updateWorkflowMission(MISSION_ID, { name: "n" })],
    [409, "not_launchable", () => launchTaskMission(MISSION_ID)],
    [422, "unsupported_mission", () => getWorkflowMission(MISSION_ID)],
    [503, "blueprint_unavailable", () => launchWorkflowMission(MISSION_ID)]
  ]

  it.each(cases)(
    "surfaces a %i %s as TrellisAppApiError with the parsed body",
    async (status, code, call) => {
      fetchMock.mockResolvedValue(jsonResponse(status, { error: code, message: "nope" }))

      const error = await captureError(() => withSession("school_user", call))

      expect(error).toBeInstanceOf(TrellisAppApiError)
      expect(error).toMatchObject({ status, body: { error: code, message: "nope" } })
    }
  )
})

function missionSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "workflow",
    id: MISSION_ID,
    name: "Deposit nudge",
    channel: "email",
    status: "draft",
    launched_at: null,
    ends_at: "2026-12-15",
    paused_at: null,
    edited_at: "2026-11-04T15:00:00Z",
    created_by: "Jessica Atreides",
    ...overrides
  }
}

function workflowMissionDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...missionSummary(),
    instructions: "Remind admitted students the deposit is due.",
    segment: { uid: "seg_admitted_fall_2027", name: "Admitted, Fall 2027" },
    goal_filters: [{ type: "string_match", property_key: "deposit_status", value: ["paid"] }],
    goal_filters_unreadable: false,
    sender_id: 11,
    max_sends: 3,
    min_days_apart: 2,
    cta_url: "https://arrakis.edu/deposit",
    cta_text: "Pay deposit",
    ...overrides
  }
}

function taskMissionDetail(): Record<string, unknown> {
  return {
    ...missionSummary({ kind: "task", channel: null, name: "Transcript chase" }),
    instructions: "Ask for the final transcript.",
    segment: { uid: "seg_missing_transcripts", name: "Missing transcripts" },
    host_agent: { id: 42, name: "Recruiter" },
    goal_filters: null,
    goal_filters_unreadable: true
  }
}

function withSession<T>(subjectType: SubjectType, fn: () => T): T {
  const session: SessionCookie = {
    accessToken: ACCESS_TOKEN,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    user: { name: "Test operator", emailHashes: [], subjectType }
  }
  const request = new Request("https://app.example.com/", {
    headers: {
      cookie: signedCookieHeader({
        name: SESSION_COOKIE,
        value: session,
        maxAgeSeconds: 600
      }).split(";")[0]!
    }
  })
  return runWithRequest({ request }, fn)
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  })
}

async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (err) {
    return err
  }
  throw new Error("Expected function to throw, but it did not")
}
