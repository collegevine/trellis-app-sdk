import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest"
import {
  evaluateFunction,
  executeAction,
  queryOntology,
  TrellisAppApiError,
  type ActionReceipt,
  type ExecuteActionRequest,
  type FunctionEvaluation,
  type FunctionReference
} from "../src/index.js"
import { executeAction as executeOntologyAction } from "./ontology.js"
import {
  SESSION_COOKIE,
  type SessionCookie,
  type SubjectType
} from "./auth/cookies.js"
import { runWithRequest } from "./context.js"
import { signedCookieHeader } from "./cookies.js"

const BASE_URL = "https://api.example.com/trellis/apps/api/v1/"
const SECRET = "tas_speak-friend-and-enter"
const DATA_SCHEMA = "ontology_v2"
const SQL = "SELECT id, name FROM students"
const ACCESS_TOKEN = "tau_signed-in-user"

type ExecuteAction = (submission: ExecuteActionRequest) => Promise<ActionReceipt>

const PERSON_LABEL: FunctionReference = {
  dataSchema: "ontology_v2",
  key: "person_label"
}

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
          asOf: new Date("2026-09-30T11:00:00-04:00"),
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
        as_of: "2026-09-30T15:00:00.000Z",
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
        arguments: { subject: "1042", asOf: null }
      })
    )

    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string)
    expect(body.action).toEqual({
      data_schema: "ontology_v2",
      key: "submit_banner_form"
    })
    expect(body.arguments.subject).toBe("1042")
    expect(body.arguments.as_of).toBeNull()
    expect(body).not.toHaveProperty("constituent_id")
    expect(init.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
  })

  describe("with an optional constituent id", () => {
    const action = { dataSchema: "ontology_v2", key: "submit_banner_form" }

    it("accepts a request without constituentId at the type level", () => {
      expectTypeOf<{
        action: typeof action
        arguments: { subject: number }
      }>().toMatchTypeOf<ExecuteActionRequest>()
    })

    it.each(["school_user", "hq_user"] as const)(
      "submits a %s action without constituent_id so it runs with only the App's permissions",
      async (subjectType) => {
        const receipt = completedReceipt()
        fetchMock.mockResolvedValue(jsonResponse(200, { data: receipt }))

        const result = await withSession(subjectType, () =>
          executeAction({ action, arguments: { subject: 1042 } })
        )

        expect(result).toEqual(receipt)
        expect(fetchMock).toHaveBeenCalledOnce()
        const [, init] = fetchMock.mock.calls[0]!
        expect(init.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
        expect(JSON.parse(init.body as string)).toEqual({
          action: { data_schema: "ontology_v2", key: "submit_banner_form" },
          arguments: { subject: 1042 }
        })
      }
    )

    it.each(["school_user", "hq_user"] as const)(
      "submits a %s action with constituent_id when one is given",
      async (subjectType) => {
        fetchMock.mockResolvedValue(jsonResponse(200, { data: completedReceipt() }))

        await withSession(subjectType, () =>
          executeAction({ action, arguments: { subject: 1042 }, constituentId: 130 })
        )

        const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
        expect(body.constituent_id).toBe(130)
      }
    )

    it("forwards a constituent session's constituentId unchanged for Rails to ignore", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { data: completedReceipt() }))

      await withSession("constituent", () =>
        executeAction({ action, arguments: { subject: "1042" }, constituentId: 130 })
      )

      const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
      expect(body.constituent_id).toBe(130)
    })

    it("never sends constituent_id as null when it is omitted", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { data: completedReceipt() }))

      await withSession("school_user", () =>
        executeAction({ action, arguments: { subject: 1042 }, constituentId: undefined })
      )

      const raw = fetchMock.mock.calls[0]![1].body as string
      expect(raw).not.toContain("constituent_id")
    })

    it("sends a constituentId of 0 rather than dropping it, leaving validation to Rails", async () => {
      const body = {
        error: "bad_request",
        message: "constituent_id must be greater than or equal to 1"
      }
      fetchMock.mockResolvedValue(jsonResponse(400, body))

      const error = await captureError(() =>
        withSession("school_user", () =>
          executeAction({ action, arguments: { subject: 1042 }, constituentId: 0 })
        )
      )

      expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string).constituent_id).toBe(0)
      expect(error).toBeInstanceOf(TrellisAppApiError)
      expect(error).toMatchObject({ status: 400, body })
    })

    it("still rejects an anonymous deployment when constituentId is omitted", async () => {
      process.env.TRELLIS_APP_AUTH_MODE = "anonymous"

      const error = await captureError(() =>
        withSession("school_user", () =>
          executeAction({ action, arguments: { subject: 1042 } })
        )
      )

      expect(error).toBeInstanceOf(TrellisAppApiError)
      expect(error).toMatchObject({ status: 401 })
      expect(fetchMock).not.toHaveBeenCalled()
    })
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

describe("evaluateFunction", () => {
  beforeEach(() => {
    process.env.TRELLIS_APP_AUTH_MODE = "authenticated"
  })

  it("types result as unknown by default and as the caller's TResult when given", () => {
    // Typed call sites, never invoked: ReturnType<typeof evaluateFunction>
    // would instantiate TResult as unknown rather than its default.
    const untyped = () =>
      evaluateFunction({ function: PERSON_LABEL, arguments: { subject: "p1" } })
    const typed = () =>
      evaluateFunction<string>({ function: PERSON_LABEL, arguments: { subject: "p1" } })
    expectTypeOf<Awaited<ReturnType<typeof untyped>>["result"]>().toEqualTypeOf<unknown>()
    expectTypeOf<
      Awaited<ReturnType<typeof typed>>
    >().toEqualTypeOf<FunctionEvaluation<string>>()
  })

  describe("evaluating with real data", () => {
    it("POSTs a staff evaluation with the user's access token and returns the unwrapped evaluation", async () => {
      const evaluation = {
        function: "person_label",
        rev: 2,
        subject: "p1",
        result: "Real|Person"
      }
      fetchMock.mockResolvedValue(jsonResponse(200, { data: evaluation }))

      const result = await withSession("school_user", () =>
        evaluateFunction({
          function: PERSON_LABEL,
          arguments: {
            subject: "p1",
            asOf: new Date("2025-12-31T19:00:00-05:00")
          },
          constituentId: 123
        })
      )

      expect(result).toEqual(evaluation)
      expect(fetchMock).toHaveBeenCalledOnce()
      const [url, init] = fetchMock.mock.calls[0]!
      expect(url).toBe(`${BASE_URL}functions/evaluate`)
      expect(init.method).toBe("POST")
      expect(init.headers).toEqual({
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      })
      expect(JSON.parse(init.body as string)).toEqual({
        function: { data_schema: "ontology_v2", key: "person_label" },
        arguments: { subject: "p1", as_of: "2026-01-01T00:00:00.000Z" },
        constituent_id: 123
      })
    })

    it("accepts a null asOf as evaluation start", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { data: realEvaluation() }))

      await withSession("constituent", () =>
        evaluateFunction({
          function: PERSON_LABEL,
          arguments: { subject: "p1", asOf: null }
        })
      )

      // Rails treats an omitted and a null as_of the same way.
      const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
      expect(body.arguments.as_of ?? null).toBeNull()
    })

    it("never sends a null hypotheticals object, which Rails rejects", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { data: realEvaluation() }))

      await withSession("constituent", () =>
        evaluateFunction({ function: PERSON_LABEL, arguments: { subject: "p1" } })
      )

      const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
      expect(body.arguments.hypotheticals).not.toBeNull()
    })
  })

  describe("evaluating with hypotheticals", () => {
    it("sends the hypotheticals and returns the echoed hypotheticals with the hypothetical result", async () => {
      const evaluation = {
        function: "person_label",
        rev: 2,
        subject: "p1",
        hypotheticals: { first: "Hypothetical" },
        result: "Hypothetical|Person"
      }
      fetchMock.mockResolvedValue(jsonResponse(200, { data: evaluation }))

      const result = await withSession("constituent", () =>
        evaluateFunction({
          function: PERSON_LABEL,
          arguments: { subject: "p1", hypotheticals: { first: "Hypothetical" } }
        })
      )

      expect(result).toEqual(evaluation)
      const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
      expect(body.arguments).toEqual({
        subject: "p1",
        hypotheticals: { first: "Hypothetical" }
      })
    })

    it("sends null replacement values verbatim rather than dropping them", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { data: realEvaluation() }))
      const hypotheticals = { middle: null, address: { line2: null } }

      await withSession("constituent", () =>
        evaluateFunction({
          function: PERSON_LABEL,
          arguments: { subject: "p1", hypotheticals }
        })
      )

      const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
      expect(body.arguments.hypotheticals).toEqual(hypotheticals)
    })
  })

  describe("preserving JSON types", () => {
    it.each([
      { label: "null", value: null },
      { label: "false", value: false }
    ])("returns a result of $label rather than treating it as missing", async ({ value }) => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { data: { ...realEvaluation(), result: value } })
      )

      const evaluation = await withSession("constituent", () =>
        evaluateFunction({ function: PERSON_LABEL, arguments: { subject: "p1" } })
      )

      expect(evaluation.result).toStrictEqual(value)
    })

    it("keeps a numeric subject a number on the wire", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { data: { ...realEvaluation(), subject: 1042 } })
      )

      const evaluation = await withSession("constituent", () =>
        evaluateFunction({ function: PERSON_LABEL, arguments: { subject: 1042 } })
      )

      const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
      expect(body.arguments.subject).toBe(1042)
      expect(evaluation.subject).toBe(1042)
    })
  })

  it("throws TrellisAppApiError when a 200 evaluation has no result key", async () => {
    const { result: _omitted, ...withoutResult } = realEvaluation()
    fetchMock.mockResolvedValue(jsonResponse(200, { data: withoutResult }))

    const error = await captureError(() =>
      withSession("constituent", () =>
        evaluateFunction({ function: PERSON_LABEL, arguments: { subject: "p1" } })
      )
    )

    expect(error).toBeInstanceOf(TrellisAppApiError)
    expect(error).toMatchObject({ status: 200 })
  })

  it("rejects an anonymous deployment without sending its deployment secret", async () => {
    process.env.TRELLIS_APP_AUTH_MODE = "anonymous"

    const error = await captureError(() =>
      withSession("school_user", () =>
        evaluateFunction({
          function: PERSON_LABEL,
          arguments: { subject: "p1" },
          constituentId: 123
        })
      )
    )

    expect(error).toBeInstanceOf(TrellisAppApiError)
    expect(error).toMatchObject({ status: 401, body: { error: "unauthorized" } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    {
      status: 422,
      body: {
        error: "functions_error",
        message:
          'hypotheticals for function "person_label": argument "unknown" is not declared by the function',
        details: { code: "FUNCTION_HYPOTHETICALS_INVALID" }
      }
    },
    {
      status: 504,
      body: { error: "functions_timeout", message: "Function evaluation timed out" }
    }
  ])(
    "preserves the $status $body.error response and makes no automatic retry",
    async ({ status, body }) => {
      fetchMock.mockResolvedValue(jsonResponse(status, body))

      const error = await captureError(() =>
        withSession("school_user", () =>
          evaluateFunction({
            function: PERSON_LABEL,
            arguments: { subject: "p1", hypotheticals: { unknown: 1 } },
            constituentId: 123
          })
        )
      )

      expect(error).toBeInstanceOf(TrellisAppApiError)
      expect(error).toMatchObject({ status, body })
      expect(fetchMock).toHaveBeenCalledOnce()
    }
  )
})

function realEvaluation() {
  return {
    function: "person_label",
    rev: 2,
    subject: "p1" as string | number,
    result: "Real|Person" as unknown
  }
}

function withSession<T>(subjectType: SubjectType, fn: () => T): T {
  const session: SessionCookie = {
    accessToken: ACCESS_TOKEN,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    user: { name: "Test user", emailHashes: [], subjectType }
  }
  const request = new Request("https://app.example.com/", {
    headers: {
      cookie: signedCookieHeader({
        name: SESSION_COOKIE,
        value: session,
        maxAgeSeconds: 600
      }).split(";")[0]
    }
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
