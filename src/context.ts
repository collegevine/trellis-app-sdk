// Per-request "ambient" state, propagated across async/await using
// Node's AsyncLocalStorage. Direct analog of .NET's AsyncLocal<T>.
//
// The Lambda adapter populates the store once per invocation, before
// either the auth middleware or any user code runs. Server-side
// helpers (e.g., getTrellisUser) read from it without having to thread
// the Request argument through every call site.

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
