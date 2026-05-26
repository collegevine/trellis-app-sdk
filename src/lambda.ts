// Adapter that lets a Trellis App run as an AWS Lambda function. Its job is to
// bridge the API Gateway v2 event shape to the Fetch-based request handler
// that RRv7 exports and back.
//
// The Lambda function's handler config points directly at the `handler`
// symbol exported from this file:
//
//   handler = "node_modules/@collegevine/trellis-app-sdk/dist/lambda.handler"
//
// On first invocation the adapter loads the app's RRv7 server build from
// /var/task/server/index.js, builds a Fetch request handler with
// react-router's createRequestHandler, and caches it. Subsequent invocations
// reuse the cached handler.

import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

export type FetchHandler = (request: Request) => Promise<Response>

export interface APIGatewayProxyEventV2 {
  rawPath: string
  rawQueryString?: string
  headers?: Record<string, string | undefined>
  cookies?: string[]
  body?: string
  isBase64Encoded?: boolean
  requestContext: {
    domainName: string
    http: { method: string }
  }
}

export interface APIGatewayProxyStructuredResultV2 {
  statusCode: number
  headers: Record<string, string>
  cookies: string[]
  body: string
  isBase64Encoded: boolean
}

export type LambdaHandler = (
  event: APIGatewayProxyEventV2
) => Promise<APIGatewayProxyStructuredResultV2>

// Where RRv7 emits the server build inside the Lambda deployment package.
const RRV7_SERVER_BUILD_PATH = "server/index.js"

let cachedFetchHandler: Promise<FetchHandler> | null = null

export const handler: LambdaHandler = async (event) => {
  console.log(event)
  cachedFetchHandler ??= loadFetchHandler()
  const fetchHandler = await cachedFetchHandler
  const response = await runFetchHandler(fetchHandler, event)
  console.log(response)
  return response
}

async function loadFetchHandler(): Promise<FetchHandler> {
  const root = process.env.LAMBDA_TASK_ROOT ?? process.cwd()
  const buildUrl = pathToFileURL(resolve(root, RRV7_SERVER_BUILD_PATH)).href
  // Imports are routed through a non-string-literal specifier so the SDK's
  // typecheck doesn't require react-router to be installed. The dep ships with
  // every RRv7 app at runtime.
  const reactRouterSpecifier = "react-router"
  const [reactRouter, build] = await Promise.all([
    import(reactRouterSpecifier) as Promise<{createRequestHandler: (build: unknown) => FetchHandler}>,
    import(buildUrl)
  ])
  return reactRouter.createRequestHandler(build)
}

// Exported so tests can exercise the event translation without exercising
// the dynamic build load.
export function createLambdaHandler(fetchHandler: FetchHandler): LambdaHandler {
  return (event) => runFetchHandler(fetchHandler, event)
}

async function runFetchHandler(
  fetchHandler: FetchHandler,
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
  const request = lambdaEventToRequest(event)
  const response = await fetchHandler(request)
  return await responseToLambdaResult(response)
}

function lambdaEventToRequest(event: APIGatewayProxyEventV2): Request {
  const host =
    event.headers?.host ??
    event.headers?.Host ??
    event.requestContext.domainName
  const query = event.rawQueryString ? `?${event.rawQueryString}` : ""
  const url = new URL(`https://${host}${event.rawPath}${query}`)

  const headers = new Headers()
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(key, value)
  }
  if (event.cookies && event.cookies.length > 0) {
    headers.set("cookie", event.cookies.join("; "))
  }

  const method = event.requestContext.http.method
  const init: RequestInit = { method, headers }
  if (event.body && method !== "GET" && method !== "HEAD") {
    init.body = event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : event.body
  }
  return new Request(url, init)
}

async function responseToLambdaResult(
  response: Response
): Promise<APIGatewayProxyStructuredResultV2> {
  // Headers.forEach folds multiple Set-Cookie values into a single
  // comma-joined string, which corrupts cookies that contain commas. API
  // Gateway v2 has a separate `cookies` array for exactly this reason.
  const cookies = response.headers.getSetCookie?.() ?? []
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") headers[key] = value
  })

  const buffer = Buffer.from(await response.arrayBuffer())
  const contentType = response.headers.get("content-type") ?? ""
  const isText =
    /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded))/.test(
      contentType
    )

  return {
    statusCode: response.status,
    headers,
    cookies,
    body: isText ? buffer.toString("utf-8") : buffer.toString("base64"),
    isBase64Encoded: !isText
  }
}
