import { describe, expect, it, vi } from "vitest"
import {
  createLambdaHandler,
  type APIGatewayProxyEventV2,
  type FetchHandler
} from "./lambda.js"

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

describe("createLambdaHandler", () => {
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
      })
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
      })
    )

    expect(seen.mock.calls[0]![0].url).toBe("https://dispatcher.example.com/")
  })

  it("merges the API Gateway cookies array into a single Cookie header", async () => {
    const seen = vi.fn<FetchHandler>(async () => new Response("ok"))
    const handler = createLambdaHandler(seen)

    await handler(
      baseEvent({
        cookies: ["session=force-is-strong", "theme=tatooine"]
      })
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
      })
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
      })
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

    const result = await createLambdaHandler(fetchHandler)(baseEvent())

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

    const result = await createLambdaHandler(fetchHandler)(baseEvent())

    expect(result.isBase64Encoded).toBe(false)
    expect(result.body).toBe("<h1>Hello, Naboo</h1>")
  })
})
