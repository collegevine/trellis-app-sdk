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

```ts
import { queryTinybirdPipe } from "@collegevine/trellis-app-sdk"

const result = await queryTinybirdPipe("agents__count", {
  start_date: "2026-01-01"
})

console.log(result.data)
```

The school and agent-instance scope are filled in server-side from the
deployment; do not pass `school_id` or `agent_instance_id` yourself.

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
