# @collegevine/trellis-app-sdk

Server-side SDK for Trellis Apps. Calls the Trellis App API on your
behalf using the deployment-issued bearer secret.

This package is server-only. The bearer secret must never be exposed to
the browser.

## Install

```bash
npm install github:collegevine/trellis-app-sdk
```

## Required environment

The SDK reads two variables on every call. They are injected
automatically into Vercel-deployed Trellis Apps; supply them yourself
when running locally.

| Variable                   | Purpose                                  |
| -------------------------- | ---------------------------------------- |
| `TRELLIS_APP_API_URL`      | Base URL of the Trellis App API.         |
| `TRELLIS_APP_API_SECRET`   | Per-deployment bearer secret.            |

## Usage

### Tinybird

```ts
import { queryTinybirdPipe } from "@collegevine/trellis-app-sdk"

const result = await queryTinybirdPipe("agents__count", {
  start_date: "2026-01-01"
})

console.log(result.data)
```

The school and agent-instance scope are filled in server-side from the
deployment; do not pass `school_id` or `agent_instance_id` yourself.

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

## Development

```bash
npm install
npm test
npm run build
```
