# @collegevine/trellis-app-sdk

Server-side SDK for Trellis Apps. Calls the Trellis App API on your
behalf, transparently switching between two authentication modes
chosen at deploy time.

This package is server-only. Credentials must never be exposed to the
browser.

## API reference

The full API reference is generated from the source and published at
<https://collegevine.github.io/trellis-app-sdk/>. It is the authoritative,
always-current list of every function and type, with parameters, return
values, thrown error codes, and examples.

## Install

```bash
npm install github:collegevine/trellis-app-sdk
```

## Required environment

Every Trellis App, regardless of mode, gets these:

| Variable                        | Purpose                              |
| ------------------------------- | ------------------------------------ |
| `TRELLIS_APP_API_URL`           | Base URL of the Trellis App API.     |
| `TRELLIS_APP_AUTH_MODE`         | `anonymous` or `authenticated`.      |
| `TRELLIS_APP_UPLOADS_BUCKET`    | S3 bucket that end-user file uploads |
|                                 | land in.                             |
| `TRELLIS_APP_UPLOADS_PREFIX`    | This app's own subdirectory in that  |
|                                 | bucket.                              |
| `TRELLIS_APP_UPLOADS_MAX_BYTES` | Per-file cap, signed into each       |
|                                 | presigned upload so S3 enforces it.  |
| `AWS_REGION`                    | Set by the Lambda runtime.           |

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

### Ontology

Run a read-only SQL query against the school's ontology. Access is
governed: the query runs as the deployment's agent instance and returns
only the subset the agent's permission groups grant. Every query targets
a named data schema.

```ts
import { queryOntology } from "@collegevine/trellis-app-sdk"

const { columns, rows, truncated } = await queryOntology({
  dataSchema: "ontology_v2",
  sql: "SELECT id, name FROM core_person",
  maxRows: 500
})

console.log(columns) // [{ name: "id", type: "BIGINT" }, ...]
console.log(rows[0]) // ["1", "Paul Atreides"]
```

`rows` come back as arrays in `columns` order; every non-null cell is a
string, whatever its SQL type. `truncated` is true when `maxRows` (or the
service's default cap) was hit. Discover the data schemas available to a
school with the `list_ontology_data_schemas` MCP tool, and a schema's
tables and columns with `describe_ontology_effective_schema`, during
development.

A query for data the agent's permissions do not cover receives
`ontology_forbidden` (HTTP 403); a deployment with no agent instance or a
school with no ontology configured receives `ontology_not_configured`
(HTTP 422).

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

### Files (images and PDFs)

To send an image or PDF to the model, first upload the bytes with
`uploadFile`, then pass the returned `upload_id` in the `uploadIds` argument
to `runLlmInference`. Message `content` stays a plain string; uploads are a
separate top-level list:

```ts
import { runLlmInference, uploadFile } from "@collegevine/trellis-app-sdk"

const { upload_id } = await uploadFile(pdfBytes, "application/pdf", "Q3-report.pdf")

const { text } = await runLlmInference(
  [{ role: "user", content: "What does this report conclude?" }],
  [upload_id]
)
```

`uploadFile` takes the raw bytes (`Uint8Array`), a content type, and a
filename. Only `image/jpeg`, `image/png`, `image/gif`, `image/webp`, and
`application/pdf` are accepted; anything else returns
`unsupported_file_type` (HTTP 400), and a file over the size cap returns
`file_too_large` (HTTP 400). The filename is required, but may or may not be passed to the underlying LLM, depending on the model capabilities. Omitting the filename returns
`invalid_file` (HTTP 400). Referencing an unknown or expired
upload returns `upload_not_found` (HTTP 400), and an `uploadIds` value that
is not a list of id strings returns `invalid_upload_ids` (HTTP 400).

This is only for uploading files that the app happens to already have somehow -
e.g. generated by the app or downloaded from elsewhere. For user-uploaded files,
see [User file uploads](#user-file-uploads). These work differently, via S3
pre-signed URLs, in order to work around AWS Lambda's limit on request size.

### User file uploads

Files a user picks in the browser do not go through the app server at all.
Posting bytes to one of the app's own actions fails above roughly 4.5MB,
because the request has to fit inside a Lambda invocation payload; that
failure is why this path exists.

The browser calls `uploadFile` from the `/client` subpath — the only module in
this package meant for client code. The `uploadFiles` function will asks the
app's own server (via SDK-handled route) for a presigned URL and then PUT the
file straight to S3:

```tsx
import { uploadFile } from "@collegevine/trellis-app-sdk/client"

const { s3Key } = await uploadFile(file, {
  onProgress: ({ loaded, total }) => setPercent((loaded / total) * 100)
})
await fetch("/receipts", { method: "POST", body: JSON.stringify({ s3Key }) })
```

The app stores the `s3Key` and nothing else. To show the file back to a user,
resolve the key in a loader with `fileUrl` and pass the URL down:

```ts
import { fileUrl } from "@collegevine/trellis-app-sdk"

export async function loader() {
  return { url: await fileUrl(receipt.s3_key) }
}
```

Such read URLs returned by `fileUrl` expire in five minutes, so mint them per
render rather than storing them long-term.

The SDK serves the presigning endpoint itself, at the reserved path
`POST /_trellis/uploads`; an app does not write a route for it.

Every app gets its own S3 location, isolated from other apps. So apps cannot
mess with each other's user uploads.

A refused claim comes back as `UploadError` with `body.error` set to
`file_too_large`, `unsupported_file_type` (missing content type, or one
carrying parameters such as `; charset=`), or `invalid_file` (blank filename
or a size that is not a positive integer). `fileUrl` throws
`TrellisAppApiError` with `forbidden_key` (HTTP 403) for a key belonging to
another app.

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
