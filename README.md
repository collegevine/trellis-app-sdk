# @collegevine/trellis-app-sdk

Server-side SDK for Trellis Apps. Calls the Trellis App API on your
behalf, transparently switching between two authentication modes
chosen at deploy time.

This package is server-only. Credentials must never be exposed to the
browser.

## Install

```bash
npm install github:collegevine/trellis-app-sdk
```

## Required environment

Every Trellis App, regardless of mode, gets these:

| Variable                | Purpose                                  |
| ----------------------- | ---------------------------------------- |
| `TRELLIS_APP_API_URL`   | Base URL of the Trellis App API.         |
| `TRELLIS_APP_AUTH_MODE` | `anonymous` or `authenticated`.          |

Anonymous-mode apps additionally get:

| Variable                | Purpose                                  |
| ----------------------- | ---------------------------------------- |
| `TRELLIS_APP_API_SECRET`| Per-deployment bearer secret.            |

Authenticated-mode apps additionally get:

| Variable                    | Purpose                                |
| --------------------------- | -------------------------------------- |
| `TRELLIS_APP_API_SECRET`    | Confidential client secret used at the |
|                             | OAuth token-exchange endpoint only.    |
| `TRELLIS_APP_AUTHORIZE_URL` | URL of the Rails authorize endpoint,   |
|                             | with `app_id` already baked into the   |
|                             | query string.                          |

Database-enabled apps additionally get:

| Variable       | Purpose                                            |
| -------------- | -------------------------------------------------- |
| `DATABASE_URL` | Passwordless connection string for the app's       |
|                | private Postgres database, reached through the      |
|                | Trellis RDS Proxy. The password is an IAM token the |
|                | SDK mints per connection, so it is absent here.    |
| `AWS_REGION`   | Set by the Lambda runtime; used to sign the token. |

These are injected automatically into Vercel-deployed Trellis Apps;
supply them yourself when running locally.

## Authentication modes

### Anonymous

The SDK uses `TRELLIS_APP_API_SECRET` on every call. The deployed app
serves all visitors without sign-in.

### Authenticated

End users sign in through the main CollegeVine Rails app, the SDK
forwards a per-user access token to the API, and pages are gated by
middleware.

The agent does not write `middleware.ts`. Trellis injects it into the
deployed file set (on top of the agent's tarball) whenever an app is
deployed in authenticated mode. The injected content is just a single
re-export from this package, equivalent to:

```ts
export { middleware, config } from "@collegevine/trellis-app-sdk/auth/middleware"
```

The middleware:

- Gates every non-static path: missing or expired session redirects
  to the auth flow.
- Serves the three OAuth control paths (`login`, `callback`, `logout`)
  itself; no extra route handlers needed.

Anonymous-mode apps do not get a `middleware.ts` at all.

To read the signed-in user from a server component or route handler:

```ts
import { getTrellisUser } from "@collegevine/trellis-app-sdk/auth/server"

export default async function Page() {
  const user = await getTrellisUser()
  return <p>Hello, {user?.name ?? "there"}</p>
}
```

The user shape is `{ name: string | null }`. The SDK deliberately does
not surface user id or email to the deployed app; the API call itself
is already scoped to the signed-in user on the server side, so the
app does not need to identify them. `getTrellisUser()` returns `null`
when there is no live session; in practice the middleware will have
redirected before the page renders.

A "Sign out" link is just a link to `/api/trellis-auth/logout`.

## Usage

### Tinybird

```ts
import { queryTinybirdPipe } from "@collegevine/trellis-app-sdk"

const result = await queryTinybirdPipe("agents__count", {
  start_date: "2026-01-01"
})

console.log(result.data)
```

The school and agent-instance scope are filled in server-side; do not
pass `school_id` or `agent_instance_id` yourself.

### Slate

For deployments backed by an agent whose product has Slate credentials
configured, run a read-only SQL query against the school's Slate CRM:

```ts
import { querySlate } from "@collegevine/trellis-app-sdk"

const { columns, rows } = await querySlate(
  "SELECT TOP 100 first_name, last_name FROM person"
)

console.log(columns) // ["first_name", "last_name"]
console.log(rows[0]) // ["Frodo", "Baggins"]
```

`rows` come back as arrays in `columns` order. For typed access, pass a
tuple type:

```ts
const { rows } = await querySlate<[string, string]>(
  "SELECT first_name, last_name FROM person"
)
```

Queries are aborted after 25 seconds. The Slate Direct SQL endpoint is
read-only on the Slate side. Deployments without an agent or whose
product has no Slate credential receive `slate_not_configured` (HTTP
422).

### LLM inference

Run a single LLM inference. The app supplies a free-form message array
and gets back the completion text:

```ts
import { runLlmInference } from "@collegevine/trellis-app-sdk"

const { text } = await runLlmInference([
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "Summarize the Treaty of Versailles in one sentence." }
])

console.log(text)
```

The model is chosen server-side; the app does not pick it. Each call is
stateless, so pass the full conversation every time. Roles are
`system`, `user`, or `assistant`. Token usage is metered to the school
that owns the deployment.

There is no per-app quota, but the combined message content is capped:
oversized input returns `input_too_large` (HTTP 400), a malformed
message array returns `invalid_messages` (HTTP 400), and the upstream
provider's rate limit surfaces as `llm_rate_limited` (HTTP 429).

### Database

Apps deployed with a database get a private Postgres schema and a
`DATABASE_URL`. `appDatabase()` returns a connection pool that
authenticates to the RDS Proxy with a short-lived IAM token, minted
fresh on every new connection — there is no static password anywhere.

```ts
import { appDatabase } from "@collegevine/trellis-app-sdk"

const { rows } = await appDatabase().query(
  "SELECT id, title FROM notes ORDER BY created_at DESC LIMIT 10"
)
```

The pool is created lazily on first use and reused across invocations.
Use it directly for queries, for transactions via
`appDatabase().connect()`, or as the driver for an ORM (Drizzle,
Kysely, and the like). The connection's `search_path` is pinned to the
app's own schema, so unqualified table names resolve there; you create
and migrate your own tables.

Only database-enabled apps get a `DATABASE_URL`; calling
`appDatabase()` without one throws. Request a database at deploy time
with `database_enabled`.

## Errors

Any non-2xx response throws `TrellisAppApiError`:

```ts
import { TrellisAppApiError } from "@collegevine/trellis-app-sdk"

try {
  await queryTinybirdPipe("not_a_real_pipe")
} catch (err) {
  if (err instanceof TrellisAppApiError) {
    console.error(err.status, err.body)
  }
}
```

In authenticated mode, a 401 from the SDK with no body indicates the
session cookie was missing or expired; the middleware should have
redirected the user to `/api/trellis-auth/login` before the API call
reached the SDK, so seeing this error usually means the middleware was
not mounted or the page was reached through some path the matcher
excludes.

## Development

```bash
npm install
npm test
npm run build
```
