import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  queryTinybirdPipe,
  TrellisAppApiError,
  type AgentsCountParams,
  type AgentsRawEventsParams
} from "../src/index.js"

const BASE_URL = "https://api.example.com/trellis/apps/api/v1/"
const SECRET = "tas_speak-friend-and-enter"
const PIPE = "agents__count"

const COUNT_PARAMS: AgentsCountParams = {
  mode: "total",
  action_or_event_id: ["email-opened"],
  date_range_after: "2026-09-21 05:00:00",
  date_range_before: "2026-09-28 05:00:00"
}

const RAW_EVENTS_PARAMS: AgentsRawEventsParams = {
  action_or_event_id: ["send-email"],
  date_range_after: "2026-09-21 05:00:00",
  date_range_before: "2026-09-28 05:00:00",
  page_size: 100,
  last_record_timestamp: "2026-09-28 05:00:00"
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
})

describe("queryTinybirdPipe", () => {
  it("calls the pipe with bearer auth and unwraps the render_success envelope", async () => {
    const tinybirdBody = {
      data: [{ name: "Frodo", count: 42 }],
      meta: [
        { name: "name", type: "String" },
        { name: "count", type: "UInt64" }
      ],
      rows: 1
    }
    fetchMock.mockResolvedValue(jsonResponse(200, { data: tinybirdBody }))

    const result = await queryTinybirdPipe(PIPE, COUNT_PARAMS)

    expect(result).toEqual(tinybirdBody)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [calledUrl, init] = fetchMock.mock.calls[0]!
    expect(calledUrl).toBe(
      "https://api.example.com/trellis/apps/api/v1/tinybird/agents__count" +
        "?mode=total&action_or_event_id=email-opened" +
        "&date_range_after=2026-09-21+05%3A00%3A00" +
        "&date_range_before=2026-09-28+05%3A00%3A00"
    )
    expect(init.method).toBe("GET")
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`)
    expect(init.headers.Accept).toBe("application/json")
  })

  it("throws TrellisAppApiError with status and parsed body on non-2xx", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, { error: "not_found", message: "Unknown pipe" })
    )

    const error = await captureError(() =>
      queryTinybirdPipe(untypedPipe("not_a_pipe"), COUNT_PARAMS)
    )

    expect(error).toBeInstanceOf(TrellisAppApiError)
    expect(error).toMatchObject({
      name: "TrellisAppApiError",
      status: 404,
      body: { error: "not_found", message: "Unknown pipe" }
    })
  })

  it("throws TrellisAppApiError when a 2xx response is not JSON", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>this is fine</html>", { status: 200 })
    )

    const error = await captureError(() => queryTinybirdPipe(PIPE, COUNT_PARAMS))

    expect(error).toBeInstanceOf(TrellisAppApiError)
    expect((error as TrellisAppApiError).status).toBe(200)
    expect((error as TrellisAppApiError).body).toBe(
      "<html>this is fine</html>"
    )
  })

  it("returns a non-JSON error body verbatim as a string", async () => {
    fetchMock.mockResolvedValue(
      new Response("upstream barfed", { status: 502 })
    )

    const error = await captureError(() => queryTinybirdPipe(PIPE, COUNT_PARAMS))

    expect(error).toBeInstanceOf(TrellisAppApiError)
    expect((error as TrellisAppApiError).status).toBe(502)
    expect((error as TrellisAppApiError).body).toBe("upstream barfed")
  })

  it("throws if TRELLIS_APP_API_URL is missing", async () => {
    delete process.env.TRELLIS_APP_API_URL
    await expect(queryTinybirdPipe(PIPE, COUNT_PARAMS)).rejects.toThrow(
      /TRELLIS_APP_API_URL/
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("throws if TRELLIS_APP_API_SECRET is missing", async () => {
    delete process.env.TRELLIS_APP_API_SECRET
    await expect(queryTinybirdPipe(PIPE, COUNT_PARAMS)).rejects.toThrow(
      /TRELLIS_APP_API_SECRET/
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("normalizes a base URL with no trailing slash", async () => {
    process.env.TRELLIS_APP_API_URL =
      "https://api.example.com/trellis/apps/api/v1"
    fetchMock.mockResolvedValue(jsonResponse(200, { data: emptyBody() }))

    await queryTinybirdPipe(PIPE, COUNT_PARAMS)

    const [calledUrl] = fetchMock.mock.calls[0]!
    expect(new URL(calledUrl).pathname).toBe(
      "/trellis/apps/api/v1/tinybird/agents__count"
    )
  })

  it("sends lists comma-separated, filters as JSON, and numbers as strings", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: emptyBody() }))

    await queryTinybirdPipe("agents__raw_events", {
      ...RAW_EVENTS_PARAMS,
      action_or_event_id: ["email-opened", "send-email"],
      target_agent_instance_ids: [25038, 25039],
      filters: [
        { type: "text", column_key: "constituent_id", condition: "present" }
      ]
    })

    const search = new URL(fetchMock.mock.calls[0]![0]).searchParams
    expect(search.get("action_or_event_id")).toBe("email-opened,send-email")
    expect(search.get("target_agent_instance_ids")).toBe("25038,25039")
    expect(search.get("filters")).toBe(
      '[{"type":"text","column_key":"constituent_id","condition":"present"}]'
    )
    expect(search.get("page_size")).toBe("100")
  })

  it("drops params whose value is undefined or null", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: emptyBody() }))

    await queryTinybirdPipe(PIPE, {
      ...COUNT_PARAMS,
      target_agent_instance_ids: undefined,
      aggregation_column_key: null as unknown as undefined
    })

    const [calledUrl] = fetchMock.mock.calls[0]!
    expect(calledUrl).not.toContain("target_agent_instance_ids")
    expect(calledUrl).not.toContain("aggregation_column_key")
  })

  it("URL-encodes the pipe name", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: emptyBody() }))

    await queryTinybirdPipe(untypedPipe("weird name/with slash"), COUNT_PARAMS)

    const [calledUrl] = fetchMock.mock.calls[0]!
    expect(calledUrl).toContain(
      "/tinybird/weird%20name%2Fwith%20slash"
    )
  })

  it("reads env vars per call, not at module load", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { data: emptyBody() }))
    )

    process.env.TRELLIS_APP_API_URL = "https://first.example.com/v1/"
    process.env.TRELLIS_APP_API_SECRET = "tas_first"
    await queryTinybirdPipe(PIPE, COUNT_PARAMS)

    process.env.TRELLIS_APP_API_URL = "https://second.example.com/v1/"
    process.env.TRELLIS_APP_API_SECRET = "tas_second"
    await queryTinybirdPipe(PIPE, COUNT_PARAMS)

    const [firstUrl, firstInit] = fetchMock.mock.calls[0]!
    const [secondUrl, secondInit] = fetchMock.mock.calls[1]!
    expect(firstUrl).toContain("first.example.com")
    expect(firstInit.headers.Authorization).toBe("Bearer tas_first")
    expect(secondUrl).toContain("second.example.com")
    expect(secondInit.headers.Authorization).toBe("Bearer tas_second")
  })

  // Enforced by `npm run typecheck`, not at runtime: the calls are never executed.
  it("rejects requests that cannot return a correct result, at compile time", () => {
    const neverCalled = () => [
      // @ts-expect-error page_size caps the count at the newest page_size events
      queryTinybirdPipe("agents__count", { ...COUNT_PARAMS, page_size: 1000 }),
      // @ts-expect-error agents__count does not paginate
      queryTinybirdPipe("agents__count", { ...COUNT_PARAMS, last_record_timestamp: "2026-09-28 05:00:00" }),
      // @ts-expect-error an explicit row type must not loosen the param check
      queryTinybirdPipe<{ count: number }>("agents__count", { ...COUNT_PARAMS, page_size: 1000 }),
      // @ts-expect-error an empty event-type list matches no events
      queryTinybirdPipe("agents__count", { ...COUNT_PARAMS, action_or_event_id: [] }),
      // @ts-expect-error template loop variables are not params
      queryTinybirdPipe("agents__count", { ...COUNT_PARAMS, _is_last: true }),
      // @ts-expect-error the date range params are date_range_after / date_range_before
      queryTinybirdPipe("agents__count", { ...COUNT_PARAMS, start_date: "2026-01-01" }),
      // @ts-expect-error a time series needs a timezone to bucket in
      queryTinybirdPipe("agents__count", { ...COUNT_PARAMS, interval_unit: "day" }),
      // @ts-expect-error agents__raw_events pages, so it needs a cursor
      queryTinybirdPipe("agents__raw_events", { ...COUNT_PARAMS }),
      // @ts-expect-error only the four proxied pipes are reachable
      queryTinybirdPipe("agents__activity", COUNT_PARAMS)
    ]
    expect(neverCalled).toBeTypeOf("function")
  })
})

// A direct literal-to-literal cast is itself a type error.
function untypedPipe(name: string): typeof PIPE {
  return name as typeof PIPE
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  })
}

function emptyBody() {
  return { data: [], meta: [], rows: 0 }
}

async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (err) {
    return err
  }
  throw new Error("Expected function to throw, but it did not")
}
