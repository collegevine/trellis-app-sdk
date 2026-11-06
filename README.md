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
| `TRELLIS_APP_COOKIE_SIGNING_KEY`| HMAC key (64 hex chars) for signed   |
|                                 | cookies, unique to the app.          |
| `TRELLIS_APP_COOKIE_NAME_PREFIX`| The per-app unique prefix for cookie |
|                                 | names, to protect from overlapping   |
|                                 | cookies via subdomains.              |

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

- Gates every non-static path: a missing, expired, edited, or unsigned
  session cookie redirects to the auth flow. Session and sign-in state
  cookies are signed with the app's key and verified on every request.
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
when there is no live, correctly signed session, and always in
anonymous mode; in authenticated mode the middleware will have
redirected before the page renders.

A "Sign out" link is just a link to `/api/trellis-auth/logout`.

## Usage

### Config

Settings and secrets the app reads at run time, such as which program to
show or a passcode, go in the `config_values` of the `deploy_app` MCP tool
rather than in the source. Every value is a string; encode numbers and lists
as strings and parse them in the app. The values are stored encrypted.

```ts
import { getAppConfig } from "@collegevine/trellis-app-sdk"

const program = (await getAppConfig()).PROGRAM ?? "MBA"
```

`getAppConfig()` fetches the values from the platform and caches them for the
life of the process. A failed fetch is not cached. The values may hold secrets,
so call it on the server and never send them to the browser.

### Signed cookies

Store small values the visitor must not be able to change. Values are
signed, not encrypted: the visitor can read them, but any edit makes
them read back as `null`. The key and cookie name prefix come from the
platform.

```ts
import {
  clearedCookieHeader,
  readSignedCookie,
  signedCookieHeader
} from "@collegevine/trellis-app-sdk"

export async function loader({ request }: { request: Request }) {
  return { prefs: readSignedCookie<{ theme: string }>(request, "prefs") }
}

export async function action() {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": signedCookieHeader({
        name: "prefs",
        value: { theme: "dark" },
        maxAgeSeconds: 86400
      })
    }
  })
}
```

`clearedCookieHeader("prefs")` deletes the cookie. Names may contain
letters, digits, `_` and `-`.

### Tinybird

```ts
import { queryTinybirdPipe } from "@collegevine/trellis-app-sdk"

const { data } = await queryTinybirdPipe("agents__activity", {
  q: `SELECT toDate(created_at) AS day, count() AS opens FROM _
      WHERE action_or_event_id = 'email-opened'
        AND created_at >= now() - INTERVAL 30 DAY
      GROUP BY day ORDER BY day`
})

console.log(data)
```

`agents__activity` returns the school's agent activity rows, and `q` is
ClickHouse SQL run over them, referenced as `_`.

- `q`: required. Always filter on `created_at` and prefer aggregates.
  An unfiltered query goes over Tinybird's 100 MiB limit and fails.
- `target_agent_instance_ids`: optional, comma-separated agent ids
  (`"25038,25041"`). Defaults to the app's own agent.

Read the JSON columns with `JSONExtractString(col, 'key')`, not
`col.key`. School and agent scope are set server-side, so do not pass
`school_id`, `agent_instance_id`, or `reachable_agent_instance_ids`.

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
governed: a signed-in HQ or school user queries as themselves and sees
only what their own permission groups grant, while an anonymous or
constituent session queries as the app, whose own permission groups are
the grant. A constituent's identity is additionally bound as the
`constituent_id` caller attribute that constituent-scoped data schemas
filter rows by. Every query targets a named data schema.

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

A query for data the acting principal's permissions do not cover
receives `ontology_forbidden` (HTTP 403); a school with no ontology
configured receives `ontology_not_configured` (HTTP 422).

Submit a published ontology Action with `executeAction`. This requires an
authenticated App deployment and a signed-in session. Staff callers may provide
a `constituentId`; without one the Action runs with only the App's permissions,
not the user's. Constituent sessions use their own identity.

```ts
import { randomUUID } from "node:crypto"
import { executeAction } from "@collegevine/trellis-app-sdk"

const submissionId = randomUUID()
const receipt = await executeAction({
  action: { dataSchema: "ontology_v1", key: "app_contract_post_note" },
  arguments: {
    subject: "person-id",
    params: { note: "Submitted by the app", submission: submissionId },
    idempotencyKey: submissionId
  },
  constituentId: 1
})

console.log(receipt.complete, receipt.succeeded, receipt.guarantee)
```

HTTP 200 returns a receipt, even when the effect is pending or failed. Inspect
`complete`, `succeeded`, `state`, and `guarantee`. The SDK does not retry Action
submissions. If a submission times out or its outcome is uncertain, retry with
the same `idempotencyKey` so the server can deduplicate it. API errors retain
their HTTP status and body in `TrellisAppApiError`.

With the seeded Monza fixture running locally, set `TRELLIS_E2E_ACCESS_TOKEN`
to a valid staff `tau_` token and `TRELLIS_E2E_SUBJECT_ID` to the seeded Banner
person ID, then run `npm run test:e2e:actions`. The test sends a fresh synthetic
submission and checks the local Banner mock for one authenticated request after
repeating the same idempotency key.

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

To send such a file to the model, adopt it: the platform copies the bytes into
its own storage on its side and hands back an upload id, which is what
`runLlmInference` takes. The bytes still never pass through the app.

```ts
import { adoptFile, runLlmInference } from "@collegevine/trellis-app-sdk"

export async function action({ request }: ActionFunctionArgs) {
  const { s3Key, filename } = await request.json()
  const uploadId = await adoptFile(s3Key, filename)
  const { text } = await runLlmInference(
    [{ role: "user", content: "Summarize this." }],
    [uploadId]
  )
  return { text }
}
```

Adopting leaves the stored file alone, so `fileUrl` keeps working for it. Only
the types `runLlmInference` accepts can be adopted, and the check is made
against the file's own bytes rather than the content type the browser declared
at upload time.

The SDK serves the presigning endpoint itself, at the reserved path
`POST /_trellis/uploads`; an app does not write a route for it.

Every app gets its own S3 location, isolated from other apps. So apps cannot
mess with each other's user uploads.

A refused claim comes back as `UploadError` with `body.error` set to
`file_too_large`, `unsupported_file_type` (missing content type, or one
carrying parameters such as `; charset=`), or `invalid_file` (blank filename
or a size that is not a positive integer). `fileUrl` and `adoptFile` throw
`TrellisAppApiError` with `forbidden_key` (HTTP 403) for a key belonging to
another app; `adoptFile` also throws `file_not_found` (HTTP 404, nothing
stored under that key), `file_too_large` (HTTP 400, over the 20MB cap),
`unsupported_file_type` (HTTP 400, the bytes are not an accepted type), and
`invalid_file` (HTTP 400, no filename).

### Exports

Exports are files the app produces for school staff to download from the
platform, such as reports. They are write-only: the app can write and delete
them, but cannot list or read them back.

```ts
import { deleteExports, exportUserUpload, writeExport } from "@collegevine/trellis-app-sdk"

await writeExport("/reports/2026-q3.csv", csv, "text/csv")
await exportUserUpload(s3Key, "/transcripts/hermione.pdf", {
  expiresAt: new Date("2027-06-01")
})
await deleteExports({ prefix: "/reports/" })
```

`writeExport` takes a path, the bytes (`Uint8Array`, or a string sent as
UTF-8), and a content type; each file is capped at 20MB. `exportUserUpload`
copies a user-uploaded file from [User file uploads](#user-file-uploads) by its `s3Key` to the export namespace. Both return the file's record. Writing to a path that already holds a file
replaces it.

Paths are case-sensitive, start with `/`, have no empty, `.` or `..` segments,
no control characters, and are at most 900 bytes. Folders are implicit.
`deleteExports({ path })` deletes one file, and `deleteExports({ prefix })`
deletes every file under a prefix ending in `/`. It returns the number of files
deleted. Exactly one of `path` and `prefix` must be present, not both.

A file expires 30 days after it is written unless `expiresAt` says otherwise,
and at most 365 days after.

### Tasks

Tasks are instructions an agent carries out for the constituents its filters
select. The Task functions need an authenticated deployment and a signed-in
operator (an HQ or school user, not a constituent). The App's agent must have a
product, and the agent you name must be in the App's scope and visible to the
operator. Writes also need write access.

```ts
import { createTask, listTasks, publishTask, updateTask } from "@collegevine/trellis-app-sdk"

const draft = await createTask(agentId, {
  title: "FAFSA check-in",
  instructionText: "Ask each student whether their FAFSA is submitted.",
  startTime: new Date("2026-11-10T14:00:00Z")
})
await updateTask(agentId, draft.task_id, { endTime: null }) // creates a new version
await publishTask(agentId, draft.task_id)

const { items, meta } = await listTasks(agentId, { limit: 50, offset: 0 })
console.log(meta.pagination?.total)
```

Inputs are camelCase. Responses keep the API's snake_case fields.
`additionalFilters`, `goalFilters` and `metadata` are sent as given. Tasks that
run a mission reject changes with 409 `mission_task`. Use the Mission functions
for those.

### Missions

Missions live in the App agent's product. There are two kinds, and their ids
are separate sequences. Workflow missions use `getWorkflowMission`,
`updateWorkflowMission`, `deleteWorkflowMission`, `checkWorkflowMissionLaunch`,
`launchWorkflowMission` and `pauseWorkflowMission`. Task missions use
`getTaskMission`, `updateTaskMission`, `checkTaskMissionLaunch`,
`launchTaskMission` and `cancelTaskMission`. Pick the function by the `kind`
of a `MissionSummary`.

The operator needs the `tester` platform role at the school to read missions
and `user` to change them. Missions must be enabled for the school and the
operator. Task missions also need the school's task-missions flag.

```ts
import {
  checkWorkflowMissionLaunch,
  createWorkflowMission,
  getMissionOptions,
  launchWorkflowMission,
  listMissions
} from "@collegevine/trellis-app-sdk"

const { senders } = await getMissionOptions()
const mission = await createWorkflowMission({
  channel: "email",
  name: "Deposit nudge",
  instructions: "Remind admitted students the deposit is due.",
  segmentUid: "seg_admitted_fall_2027",
  permissionGroupId: 501,
  senderId: senders.email?.[0]?.id,
  goalFilters: [{ type: "string_match", propertyKey: "deposit_status", value: ["paid"] }],
  endsAt: "2026-12-15"
})

const { problems } = await checkWorkflowMissionLaunch(mission.id)
if (problems.length === 0) {
  const { launch } = await launchWorkflowMission(mission.id)
  // "started", "already_running", or "pending_approval" (HTTP 202, not an error)
}

const { items, meta } = await listMissions({ tab: "drafts", perPage: 25 })
if (meta.has_more) { /* fetch page 2 */ }
```

`listMissions` returns `has_more` but no total. Multichannel missions are not
listed, and the per-mission functions reject them with 422
`unsupported_mission`.

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

### End-to-end tests against Rails

The Tasks and Missions suites (`e2e/tasks.test.mjs`, `e2e/missions.test.mjs`)
run the flows from the Rails `AppTaskMissionLifecycle` live test through the
SDK, as a deployed authenticated App would. `e2e/support.mjs` runs each SDK
call with a signed session cookie holding one of the fixture's real `tau_`
tokens.

They read the same fixture as the Rails test. Point `APP_TASKS_MISSIONS_FIXTURE`
at the `.env.app-tasks-missions-fixture.json` that the Rails seed writes, or
copy that file to this repo's root (it is gitignored). The fixture has three
actors (`operator`, `no_team`, `property_granted`), the operator App's
deployment secret, the host and owner agents, two segments, a sender, the App's
team, and a constituent property key. The suites publish tasks and launch
missions, so they refuse to run unless the fixture is the local synthetic Monza
one: Monza's school id, an `http://localhost` Rails URL, a sender domain ending
in `.invalid`, and different owner and host agents.

```bash
APP_TASKS_MISSIONS_FIXTURE=/path/to/.env.app-tasks-missions-fixture.json \
  npm run test:e2e:tasks-missions
```

Run both files with `test:e2e:tasks-missions`, which runs them one at a time.
If the files run in parallel, a task mission creates a task on the host agent
while the Tasks suite is checking that a rejected create added no task. The
permission tests skip when the fixture lacks the `no_team` or
`property_granted` actor.

The Rails test also posts a foreign `product_id` and expects Rails to ignore it.
The SDK cannot send that field, so `src/missions.test.ts` checks that request
bodies carry named inputs only.
