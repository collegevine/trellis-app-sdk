// Per-request "ambient" state, propagated across async/await using Node's AsyncLocalStorage.

import { AsyncLocalStorage } from "node:async_hooks"

interface RequestContext {
  request: Request
}

const store = new AsyncLocalStorage<RequestContext>()

export function runWithRequest<T>(request: Request, fn: () => T): T {
  return store.run({ request }, fn)
}

export function currentRequest(): Request {
  const ctx = store.getStore()
  if (!ctx) throw new Error("currentRequest called outside a request scope")
  return ctx.request
}
