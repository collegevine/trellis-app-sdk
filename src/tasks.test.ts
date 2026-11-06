import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cancelTask,
  createTask,
  getTask,
  listTasks,
  publishTask,
  TrellisAppApiError,
  updateTask
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
const AGENT_ID = 42
const TASK_ID = 1138

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

describe("listTasks", () => {
  it("GETs the agent's tasks with the session token and returns the rows with the raw meta", async () => {
    const summaries = [taskSummary()]
    const meta = { pagination: { limit: 50, offset: 0, total: 113 } }
    fetchMock.mockResolvedValue(jsonResponse(200, { data: summaries, meta }))

    const result = await withSession("school_user", () => listTasks(AGENT_ID))

    expect(result).toEqual({ items: summaries, meta })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}agents/42/tasks`)
    expect(init.method).toBe("GET")
    expect(init.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(init.body).toBeUndefined()
  })

  it("sends limit and offset as query parameters only when given", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(200, {
          data: [],
          meta: { pagination: { limit: 10, offset: 20, total: 0 } }
        })
      )
    )

    await withSession("hq_user", () => listTasks(AGENT_ID, { limit: 10, offset: 20 }))
    await withSession("hq_user", () => listTasks(AGENT_ID, { limit: 10 }))

    const [withBoth] = fetchMock.mock.calls[0]!
    const [limitOnly] = fetchMock.mock.calls[1]!
    expect(new URL(withBoth).searchParams.get("limit")).toBe("10")
    expect(new URL(withBoth).searchParams.get("offset")).toBe("20")
    expect(new URL(limitOnly).searchParams.has("offset")).toBe(false)
  })

  it("returns an empty items array when the agent has no tasks", async () => {
    const meta = { pagination: { limit: 50, offset: 0, total: 0 } }
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [], meta }))

    const result = await withSession("school_user", () => listTasks(AGENT_ID))

    expect(result).toEqual({ items: [], meta })
  })
})

describe("createTask", () => {
  it("POSTs camelCase fields as snake_case JSON, serializes dates, and returns the draft task", async () => {
    const created = task({ status: "draft" })
    fetchMock.mockResolvedValue(jsonResponse(201, { data: created }))

    const result = await withSession("school_user", () =>
      createTask(AGENT_ID, {
        title: "Spice harvest check-in",
        instructionText: "Ask each student whether their FAFSA is submitted.",
        startTime: new Date("2026-11-10T14:00:00Z"),
        endTime: new Date("2026-12-01T05:00:00Z"),
        additionalFilters: { op: "and", filters: [] },
        goalFilters: { op: "or", filters: [] },
        metadata: { source: "app" }
      })
    )

    expect(result).toEqual(created)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}agents/42/tasks`)
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(init.headers["Content-Type"]).toBe("application/json")
    expect(JSON.parse(init.body as string)).toEqual({
      title: "Spice harvest check-in",
      instruction_text: "Ask each student whether their FAFSA is submitted.",
      start_time: "2026-11-10T14:00:00.000Z",
      end_time: "2026-12-01T05:00:00.000Z",
      additional_filters: { op: "and", filters: [] },
      goal_filters: { op: "or", filters: [] },
      metadata: { source: "app" }
    })
  })

  it("sends only the fields that were given", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { data: task() }))

    await withSession("school_user", () =>
      createTask(AGENT_ID, { title: "Minimal", instructionText: "Do the thing." })
    )

    const [, init] = fetchMock.mock.calls[0]!
    expect(JSON.parse(init.body as string)).toEqual({
      title: "Minimal",
      instruction_text: "Do the thing."
    })
  })

  it("passes segment filters and metadata through verbatim, without renaming nested keys", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { data: task() }))
    const additionalFilters = {
      op: "and",
      filters: [{ propertyKey: "house_key", matchType: "string_match", values: ["Atreides"] }]
    }
    const metadata = { createdFromScreen: "taskBuilder", nested: { someKey: null } }

    await withSession("school_user", () =>
      createTask(AGENT_ID, {
        title: "Verbatim",
        instructionText: "Keep nested JSON intact.",
        additionalFilters,
        metadata
      })
    )

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.additional_filters).toEqual(additionalFilters)
    expect(body.metadata).toEqual(metadata)
  })
})

describe("getTask", () => {
  it("GETs the task at its current version", async () => {
    const current = task()
    fetchMock.mockResolvedValue(jsonResponse(200, { data: current }))

    const result = await withSession("school_user", () => getTask(AGENT_ID, TASK_ID))

    expect(result).toEqual(current)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}agents/42/tasks/1138`)
    expect(init.method).toBe("GET")
  })

  it("asks for a specific version when one is given", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: task({ version: 3 }) }))

    await withSession("school_user", () => getTask(AGENT_ID, TASK_ID, { version: 3 }))

    const [url] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}agents/42/tasks/1138?version=3`)
  })
})

describe("updateTask", () => {
  it("PATCHes only the given fields and returns the new version", async () => {
    const updated = task({ version: 2, title: "Renamed" })
    fetchMock.mockResolvedValue(jsonResponse(200, { data: updated }))

    const result = await withSession("school_user", () =>
      updateTask(AGENT_ID, TASK_ID, { title: "Renamed" })
    )

    expect(result).toEqual(updated)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}agents/42/tasks/1138`)
    expect(init.method).toBe("PATCH")
    expect(JSON.parse(init.body as string)).toEqual({ title: "Renamed" })
  })

  it("sends end_time: null to clear the end time", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: task() }))

    await withSession("school_user", () =>
      updateTask(AGENT_ID, TASK_ID, { endTime: null })
    )

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body).toEqual({ end_time: null })
  })

  it("throws TrellisAppApiError with 409 mission_task when the task runs a mission", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: "mission_task",
        message: "This task runs a mission"
      })
    )

    const error = await captureError(() =>
      withSession("school_user", () => updateTask(AGENT_ID, TASK_ID, { title: "x" }))
    )

    expect(error).toBeInstanceOf(TrellisAppApiError)
    expect(error).toMatchObject({ status: 409, body: { error: "mission_task" } })
  })
})

describe("publishTask", () => {
  it("POSTs to the publish path with no body and returns the published task", async () => {
    const published = task({ status: "active" })
    fetchMock.mockResolvedValue(jsonResponse(200, { data: published }))

    const result = await withSession("school_user", () => publishTask(AGENT_ID, TASK_ID))

    expect(result).toEqual(published)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}agents/42/tasks/1138/publish`)
    expect(init.method).toBe("POST")
    expect(init.body).toBeUndefined()
  })
})

describe("cancelTask", () => {
  it("POSTs to the cancel path with no body and returns the cancelled task", async () => {
    const cancelled = task({ status: "cancelled" })
    fetchMock.mockResolvedValue(jsonResponse(200, { data: cancelled }))

    const result = await withSession("school_user", () => cancelTask(AGENT_ID, TASK_ID))

    expect(result).toEqual(cancelled)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}agents/42/tasks/1138/cancel`)
    expect(init.method).toBe("POST")
    expect(init.body).toBeUndefined()
  })
})

describe("session requirements", () => {
  const calls: [string, () => Promise<unknown>][] = [
    ["listTasks", () => listTasks(AGENT_ID)],
    ["createTask", () => createTask(AGENT_ID, { title: "t", instructionText: "i" })],
    ["getTask", () => getTask(AGENT_ID, TASK_ID)],
    ["updateTask", () => updateTask(AGENT_ID, TASK_ID, { title: "t" })],
    ["publishTask", () => publishTask(AGENT_ID, TASK_ID)],
    ["cancelTask", () => cancelTask(AGENT_ID, TASK_ID)]
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
  it.each([
    [403, "forbidden", "write access is required"],
    [404, "not_found", "Task not found"],
    [422, "validation_error", "Title can't be blank"]
  ])(
    "surfaces a %i %s as TrellisAppApiError with the parsed body",
    async (status, code, message) => {
      fetchMock.mockResolvedValue(jsonResponse(status, { error: code, message }))

      const error = await captureError(() =>
        withSession("school_user", () => getTask(AGENT_ID, TASK_ID))
      )

      expect(error).toBeInstanceOf(TrellisAppApiError)
      expect(error).toMatchObject({ status, body: { error: code, message } })
    }
  )
})

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: TASK_ID,
    is_mission: false,
    version_id: 9001,
    version: 1,
    title: "Spice harvest check-in",
    instruction_text: "Ask each student whether their FAFSA is submitted.",
    status: "draft",
    constituent_count: 212,
    created_at: "2026-11-04T15:00:00Z",
    updated_at: "2026-11-04T15:00:00Z",
    ...overrides
  }
}

function taskSummary(): Record<string, unknown> {
  return {
    task_id: TASK_ID,
    is_mission: false,
    title: "Spice harvest check-in",
    status: "active",
    version_count: 2,
    created_at: "2026-11-04T15:00:00Z"
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
