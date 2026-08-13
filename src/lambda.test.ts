import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { currentRequestId } from "./context.js"
import {
  createLambdaHandler,
  type APIGatewayProxyEventV2,
  type FetchHandler,
  type LambdaContext
} from "./lambda.js"
import { Logger } from "./logging.js"

const baseEvent = (
  overrides: Partial<APIGatewayProxyEventV2> = {}
): APIGatewayProxyEventV2 => ({
  rawPath: "/",
  rawQueryString: "",
  headers: { host: "x-wing.dagobah.apps.collegevine.ai" },
  requestContext: {
    domainName: "dispatcher.example.com",
    http: { method: "GET" }
  },
  ...overrides
})

const baseContext = (
  overrides: Partial<LambdaContext> = {}
): LambdaContext => ({ awsRequestId: "req-test", ...overrides })

describe("createLambdaHandler", () => {
  let logged: unknown[][]

  // Capture the request start/end lines the adapter logs via Logger, keeping
  // them out of the test output.
  beforeEach(() => {
    logged = []
    vi.spyOn(Logger, "info").mockImplementation((...args: unknown[]) => {
      logged.push(args)
    })
  })

  afterEach(() => vi.restoreAllMocks())

  it("translates path, query, method, and host into a Fetch Request", async () => {
    const seen = vi.fn<FetchHandler>(async () => new Response("ok"))
    const handler = createLambdaHandler(seen)

    await handler(
      baseEvent({
        rawPath: "/x-wings",
        rawQueryString: "color=red&pilot=luke",
        requestContext: {
          domainName: "dispatcher.example.com",
          http: { method: "GET" }
        }
      }),
      baseContext()
    )

    const request = seen.mock.calls[0]![0]
    expect(request.method).toBe("GET")
    expect(request.url).toBe(
      "https://x-wing.dagobah.apps.collegevine.ai/x-wings?color=red&pilot=luke"
    )
  })

  it("falls back to requestContext.domainName when no Host header is present", async () => {
    const seen = vi.fn<FetchHandler>(async () => new Response("ok"))
    const handler = createLambdaHandler(seen)

    await handler(
      baseEvent({
        headers: {},
        requestContext: {
          domainName: "dispatcher.example.com",
          http: { method: "GET" }
        }
      }),
      baseContext()
    )

    expect(seen.mock.calls[0]![0].url).toBe("https://dispatcher.example.com/")
  })

  it("merges the API Gateway cookies array into a single Cookie header", async () => {
    const seen = vi.fn<FetchHandler>(async () => new Response("ok"))
    const handler = createLambdaHandler(seen)

    await handler(
      baseEvent({
        cookies: ["session=force-is-strong", "theme=tatooine"]
      }),
      baseContext()
    )

    expect(seen.mock.calls[0]![0].headers.get("cookie")).toBe(
      "session=force-is-strong; theme=tatooine"
    )
  })

  it("passes a base64 body through as bytes for non-GET methods", async () => {
    const seen = vi.fn<FetchHandler>(async () => new Response("ok"))
    const handler = createLambdaHandler(seen)

    const payload = Buffer.from("blue milk").toString("base64")
    await handler(
      baseEvent({
        body: payload,
        isBase64Encoded: true,
        requestContext: {
          domainName: "dispatcher.example.com",
          http: { method: "POST" }
        }
      }),
      baseContext()
    )

    const text = await seen.mock.calls[0]![0].text()
    expect(text).toBe("blue milk")
  })

  it("ignores the body for GET and HEAD requests", async () => {
    const seen = vi.fn<FetchHandler>(async () => new Response("ok"))
    const handler = createLambdaHandler(seen)

    await handler(
      baseEvent({
        body: "ignored",
        isBase64Encoded: false,
        requestContext: {
          domainName: "dispatcher.example.com",
          http: { method: "GET" }
        }
      }),
      baseContext()
    )

    const text = await seen.mock.calls[0]![0].text()
    expect(text).toBe("")
  })

  it("returns response headers, splits Set-Cookie into the cookies array, and base64-encodes binary bodies", async () => {
    const fetchHandler: FetchHandler = async () => {
      const headers = new Headers({ "content-type": "image/png" })
      headers.append("set-cookie", "first=one")
      headers.append("set-cookie", "second=two")
      return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        status: 201,
        headers
      })
    }

    const result = await createLambdaHandler(fetchHandler)(baseEvent(), baseContext())

    expect(result.statusCode).toBe(201)
    expect(result.headers["content-type"]).toBe("image/png")
    expect(result.headers["set-cookie"]).toBeUndefined()
    expect(result.cookies).toEqual(["first=one", "second=two"])
    expect(result.isBase64Encoded).toBe(true)
    expect(Buffer.from(result.body, "base64").toString("hex")).toBe(
      "89504e47"
    )
  })

  it("returns text bodies verbatim when the content type is textual", async () => {
    const fetchHandler: FetchHandler = async () =>
      new Response("<h1>Hello, Naboo</h1>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      })

    const result = await createLambdaHandler(fetchHandler)(baseEvent(), baseContext())

    expect(result.isBase64Encoded).toBe(false)
    expect(result.body).toBe("<h1>Hello, Naboo</h1>")
  })

  it("runs the handler within a request scope carrying the Lambda request id", async () => {
    let seen: string | undefined
    const fetchHandler: FetchHandler = async () => {
      seen = currentRequestId()
      return new Response("ok")
    }

    await createLambdaHandler(fetchHandler)(
      baseEvent(),
      baseContext({ awsRequestId: "req-4193" })
    )

    expect(seen).toBe("req-4193")
  })

  it("emits a request start and request end line around the handler", async () => {
    const fetchHandler: FetchHandler = async () =>
      new Response("ok", { status: 207 })

    await createLambdaHandler(fetchHandler)(
      baseEvent({
        rawPath: "/dashboard",
        rawQueryString: "tab=orders",
        headers: {
          host: "x-wing.dagobah.apps.collegevine.ai",
          "x-forwarded-client-ip": "203.0.113.7"
        }
      }),
      baseContext({ awsRequestId: "req-4194" })
    )

    const [start, end] = logged
    expect(start).toEqual([
      "request start",
      { path: "/dashboard", query: "tab=orders", clientIp: "203.0.113.7" }
    ])
    expect(end![0]).toBe("request end")
    expect(end![1]).toMatchObject({ path: "/dashboard", status: 207 })
    expect(typeof (end![1] as Record<string, unknown>).durationMs).toBe("number")
  })
})
