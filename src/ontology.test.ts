import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest"
import {
  executeAction,
  queryOntology,
  TrellisAppApiError,
  type ActionReceipt,
  type ExecuteActionRequest
} from "../src/index.js"
import { executeAction as executeOntologyAction } from "./ontology.js"
import {
  encodeCookie,
  SESSION_COOKIE,
  type SessionCookie,
  type SubjectType
} from "./auth/cookies.js"
import { runWithRequest } from "./context.js"

const BASE_URL = "https://api.example.com/trellis/apps/api/v1/"
const SECRET = "tas_speak-friend-and-enter"
const DATA_SCHEMA = "ontology_v2"
const SQL = "SELECT id, name FROM students"
const ACCESS_TOKEN = "tau_signed-in-user"

type ExecuteAction = (submission: ExecuteActionRequest) => Promise<ActionReceipt>

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  process.env.TRELLIS_APP_API_URL = BASE_URL
  process.env.TRELLIS_APP_API_SECRET = SECRET
  fetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.TRELLIS_APP_API_URL
  delete process.env.TRELLIS_APP_API_SECRET
  delete process.env.TRELLIS_APP_AUTH_MODE
})

describe("queryOntology", () => {
  it("POSTs the sql and data schema as JSON with bearer auth and unwraps the envelope", async () => {
    const ontologyBody = {
      columns: [
        { name: "id", type: "BIGINT" },
        { name: "name", type: "STRING" }
      ],
      rows: [["1", "Paul Atreides"]],
      truncated: true
    }
    fetchMock.mockResolvedValue(jsonResponse(200, { data: ontologyBody }))

    const result = await queryOntology({ dataSchema: DATA_SCHEMA, sql: SQL })

    expect(result).toEqual(ontologyBody)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [calledUrl, init] = fetchMock.mock.calls[0]!
    expect(calledUrl).toBe(
      "https://api.example.com/trellis/apps/api/v1/ontology/query"
    )
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`)
    expect(init.headers["Content-Type"]).toBe("application/json")
    expect(JSON.parse(init.body as string)).toEqual({
      sql: SQL,
      data_schema: DATA_SCHEMA
    })
  })

  it("sends max_rows only when given", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(200, { data: { columns: [], rows: [], truncated: false } })
      )
    )

    await queryOntology({ dataSchema: DATA_SCHEMA, sql: SQL, maxRows: 500 })
    await queryOntology({ dataSchema: DATA_SCHEMA, sql: SQL })

    const [, withCap] = fetchMock.mock.calls[0]!
    const [, withoutCap] = fetchMock.mock.calls[1]!
    expect(JSON.parse(withCap.body as string)).toEqual({
      sql: SQL,
      data_schema: DATA_SCHEMA,
      max_rows: 500
    })
    expect(JSON.parse(withoutCap.body as string)).not.toHaveProperty("max_rows")
  })

  it("throws TrellisAppApiError carrying status, body, and the upstream code on a governed-access failure", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, {
        error: "ontology_forbidden",
        message: "this data is scoped to caller attributes the session does not carry",
        details: { code: "CALLER_ATTRS_REQUIRED" }
      })
    )

    const error = await captureError(() =>
      queryOntology({ dataSchema: DATA_SCHEMA, sql: SQL })
    )

    expect(error).toBeInstanceOf(TrellisAppApiError)
    expect(error).toMatchObject({
      status: 403,
      body: {
        error: "ontology_forbidden",
        details: { code: "CALLER_ATTRS_REQUIRED" }
      }
    })
  })

  it("throws TrellisAppApiError when ontology_not_configured comes back as 422", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, { error: "ontology_not_configured", message: "..." })
    )

    const error = await captureError(() =>
      queryOntology({ dataSchema: DATA_SCHEMA, sql: SQL })
    )

    expect(error).toBeInstanceOf(TrellisAppApiError)
    expect((error as TrellisAppApiError).status).toBe(422)
    expect((error as TrellisAppApiError).body).toMatchObject({
      error: "ontology_not_configured"
    })
  })

  it("throws TrellisAppApiError when a 2xx response is not JSON", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>this is fine</html>", { status: 200 })
    )

    const error = await captureError(() =>
      queryOntology({ dataSchema: DATA_SCHEMA, sql: SQL })
    )

    expect(error).toBeInstanceOf(TrellisAppApiError)
    expect((error as TrellisAppApiError).status).toBe(200)
  })

  it("throws if TRELLIS_APP_API_URL is missing, without calling fetch", async () => {
    delete process.env.TRELLIS_APP_API_URL
    await expect(
      queryOntology({ dataSchema: DATA_SCHEMA, sql: SQL })
    ).rejects.toThrow(/TRELLIS_APP_API_URL/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("executeAction", () => {
  beforeEach(() => {
    process.env.TRELLIS_APP_AUTH_MODE = "authenticated"
  })

  it("is exported by the ontology module and the public SDK entrypoint", () => {
    expect(executeAction).toBe(executeOntologyAction)
    expectTypeOf(executeAction).toMatchTypeOf<ExecuteAction>()
  })

  it("submits the complete request with the user's access token and returns the pending receipt", async () => {
    const receipt = {
      invocation: "0192c7a0-0000-7000-8000-000000000000",
      action: "submit_banner_form",
      rev: 3,
      state: "authorized",
      complete_at: "confirmed",
      complete: false,
      succeeded: false,
      waiting_on: "dispatch",
      deduped: false,
      guarantee: "authorized; no effect submitted"
    }
    fetchMock.mockResolvedValue(jsonResponse(200, { data: receipt }))

    const result = await withSession("school_user", () =>
      executeAction({
        action: { dataSchema: "ontology_v2", key: "submit_banner_form" },
        arguments: {
          subject: 1042,
          params: { hold_type: "bursar" },
          resources: { term: { type: "core_term", id: "2026FA" } },
          asOf: "2026-09-30T15:00:00Z",
          idempotencyKey: "form-submission-42",
          rationale: "Submitted by the account holder"
        },
        constituentId: 130
      })
    )

    expect(result).toEqual(receipt)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}actions/execute`)
    expect(init.method).toBe("POST")
    expect(init.headers).toEqual({
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    })
    expect(JSON.parse(init.body as string)).toEqual({
      action: { data_schema: "ontology_v2", key: "submit_banner_form" },
      arguments: {
        subject: 1042,
        params: { hold_type: "bursar" },
        resources: { term: { type: "core_term", id: "2026FA" } },
        as_of: "2026-09-30T15:00:00Z",
        idempotency_key: "form-submission-42",
        rationale: "Submitted by the account holder"
      },
      constituent_id: 130
    })
  })

  it("submits a constituent action without an explicit constituent id", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: completedReceipt() }))

    await withSession("constituent", () =>
      executeAction({
        action: { dataSchema: "ontology_v2", key: "submit_banner_form" },
        arguments: { subject: "1042" }
      })
    )

    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string)
    expect(body.action).toEqual({
      data_schema: "ontology_v2",
      key: "submit_banner_form"
    })
    expect(body.arguments.subject).toBe("1042")
    expect(body).not.toHaveProperty("constituent_id")
    expect(init.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
  })

  it("returns a 200 receipt whose Action effect failed without treating it as an HTTP error", async () => {
    const receipt = completedReceipt()
    fetchMock.mockResolvedValue(jsonResponse(200, { data: receipt }))

    const result = await withSession("school_user", () =>
      executeAction({
        action: { dataSchema: "ontology_v2", key: "submit_banner_form" },
        arguments: { subject: 1042, idempotencyKey: "form-submission-42" },
        constituentId: 130
      })
    )

    expect(result).toEqual(receipt)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    {
      status: 403,
      body: {
        error: "actions_error",
        message: "Action denied",
        details: { code: "ACTION_FORBIDDEN" }
      }
    },
    {
      status: 504,
      body: { error: "actions_timeout", message: "Submission timed out" }
    }
  ])(
    "preserves the $status Rails error and makes no automatic retry",
    async ({ status, body }) => {
      fetchMock.mockResolvedValue(jsonResponse(status, body))
      const error = await captureError(() =>
        withSession("school_user", () =>
          executeAction({
            action: { dataSchema: "ontology_v2", key: "submit_banner_form" },
            arguments: { subject: 1042, idempotencyKey: "form-submission-42" },
            constituentId: 130
          })
        )
      )

      expect(error).toBeInstanceOf(TrellisAppApiError)
      expect(error).toMatchObject({ status, body })
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toMatchObject({
        arguments: { idempotency_key: "form-submission-42" }
      })
    }
  )

  it("rejects a missing user session without sending the deployment secret", async () => {
    const request = new Request("https://app.example.com/")
    const error = await captureError(() =>
      runWithRequest({ request }, () =>
        executeAction({
          action: { dataSchema: "ontology_v2", key: "submit_banner_form" },
          arguments: { subject: 1042 }
        })
      )
    )

    expect(error).toBeInstanceOf(TrellisAppApiError)
    expect(error).toMatchObject({ status: 401 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects anonymous deployments without sending their deployment secret", async () => {
    process.env.TRELLIS_APP_AUTH_MODE = "anonymous"

    const error = await captureError(() =>
      withSession("school_user", () =>
        executeAction({
          action: { dataSchema: "ontology_v2", key: "submit_banner_form" },
          arguments: { subject: 1042 },
          constituentId: 130
        })
      )
    )

    expect(error).toBeInstanceOf(TrellisAppApiError)
    expect(error).toMatchObject({ status: 401 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

function withSession<T>(subjectType: SubjectType, fn: () => T): T {
  const session: SessionCookie = {
    accessToken: ACCESS_TOKEN,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    user: { name: "Test user", emailHashes: [], subjectType }
  }
  const request = new Request("https://app.example.com/", {
    headers: { cookie: `${SESSION_COOKIE}=${encodeCookie(session)}` }
  })
  return runWithRequest({ request }, fn)
}

function completedReceipt(): ActionReceipt {
  return {
    invocation: "0192c7a0-0000-7000-8000-000000000001",
    action: "submit_banner_form",
    rev: 3,
    state: "failed",
    complete_at: "confirmed",
    complete: true,
    succeeded: false,
    deduped: true,
    guarantee: "effect failed"
  }
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
