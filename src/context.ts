// Per-request "ambient" state, propagated across async/await using Node's AsyncLocalStorage.

import { AsyncLocalStorage } from "node:async_hooks"

interface RequestContext {
  request: Request

  // The AWS Lambda request ID. Absent outside a Lambda (in tests).
  requestId?: string
}

const store = new AsyncLocalStorage<RequestContext>()

export function runWithRequest<T>(context: RequestContext, fn: () => T): T {
  return store.run(context, fn)
}

export function currentRequest(): Request {
  const ctx = store.getStore()
  if (!ctx) throw new Error("currentRequest called outside a request scope")
  return ctx.request
}

export function currentRequestId(): string | undefined {
  return store.getStore()?.requestId
}
