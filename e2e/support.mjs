// Shared harness for e2e tests that call a running Rails as if they were a
// deployed Trellis App. SDK calls run inside `asActor`/`withToken`, which set
// the SDK's environment for an authenticated deployment and park a request
// carrying a signed session cookie (holding a real `tau_` token) in the SDK's
// request context, exactly as the Lambda adapter does in production.
//
// The Tasks and Missions suites read the same fixture as the Rails
// `AppTaskMissionLifecycle` live test: `APP_TASKS_MISSIONS_FIXTURE` (the same
// variable Rails uses), else `.env.app-tasks-missions-fixture.json` at this
// repo's root. The Rails seed writes it. Shape:
//
//   {
//     "rails_url": "http://localhost:13000",
//     "school": "<Monza school uuid>",
//     "sender_domain": "<something>.invalid",
//     "owner_agent_id": 1, "host_agent_id": 2,
//     "workflow_segment_uid": "...", "task_mission_segment_uid": "...",
//     "sender_id": 3, "team_id": 4, "foreign_product_id": 5,
//     "property_key": "...",
//     "apps": {
//       "operator":         { "staff_token": "tau_...", "deployment_secret": "tas_..." },
//       "no_team":          { "staff_token": "tau_..." },
//       "property_granted": { "staff_token": "tau_..." }
//     }
//   }
//
// These suites publish tasks and launch missions, so, like the Rails test,
// they refuse to run unless the fixture is the local synthetic Monza one.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as sdk from "../dist/index.js"
import { SESSION_COOKIE } from "../dist/auth/cookies.js"
import { runWithRequest } from "../dist/context.js"

export { sdk }

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const MONZA = "aa88d148-99b2-4c02-88a6-23034323a19f"
const API_PATH = "/trellis/apps/api/v1/"

let cachedFixture

/**
 * The Tasks and Missions fixture, validated as the local synthetic Monza
 * fixture. Throws otherwise, before any request is made.
 */
export function fixture() {
  if (cachedFixture) return cachedFixture
  const path = resolve(
    REPO_ROOT,
    process.env.APP_TASKS_MISSIONS_FIXTURE ?? ".env.app-tasks-missions-fixture.json"
  )
  let loaded
  try {
    loaded = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    const nearMisses = Object.keys(process.env).filter(
      (name) => name !== "APP_TASKS_MISSIONS_FIXTURE" && /^APP_TASKS?_MISS?I?ONS?_FIXTURE$/i.test(name)
    )
    throw new Error(
      `Cannot read the App tasks/missions fixture at ${path} (${error.message}). ` +
        "Set APP_TASKS_MISSIONS_FIXTURE to the file the Rails seed wrote." +
        (nearMisses.length ? ` Found ${nearMisses.join(", ")}; is the name misspelled?` : "")
    )
  }
  assertLocalMonza(loaded)
  cachedFixture = loaded
  return loaded
}

function assertLocalMonza(f) {
  let url
  try {
    url = new URL(f.rails_url)
  } catch {
    url = undefined
  }
  const safe =
    f.school === MONZA &&
    url?.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    typeof f.sender_domain === "string" &&
    f.sender_domain.endsWith(".invalid") &&
    f.owner_agent_id !== f.host_agent_id
  if (!safe) {
    throw new Error("Live App task and mission tests require the local Monza fixture")
  }
}

/** True when the fixture defines `actor` (e.g. `no_team`, `property_granted`). */
export function hasActor(actor) {
  return Boolean(fixture().apps?.[actor]?.staff_token)
}

/**
 * Runs `fn` as the fixture's `actor` (default `operator`) signed in to an
 * authenticated App deployment, so SDK calls inside it send
 * `Authorization: Bearer <that actor's tau_ token>` to Rails.
 */
export function asActor(actor, fn) {
  const token = fixture().apps?.[actor]?.staff_token
  assert.ok(token, `The fixture has no apps.${actor}.staff_token`)
  return withToken(token, fn)
}

/** Shorthand for `asActor("operator", fn)`. */
export function asOperator(fn) {
  return asActor("operator", fn)
}

/**
 * Runs `fn` with `token` as the session's access token. Use a real `tau_`
 * token for an operator; any other credential checks that Rails rejects it.
 */
export function withToken(token, fn) {
  configureSdk("authenticated")
  const session = {
    accessToken: token,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    user: { name: "SDK e2e operator", emailHashes: [], subjectType: "school_user" }
  }
  const request = new Request("http://localhost/", {
    headers: {
      cookie: sdk
        .signedCookieHeader({ name: SESSION_COOKIE, value: session, maxAgeSeconds: 300 })
        .split(";")[0]
    }
  })
  return runWithRequest({ request }, fn)
}

/**
 * Runs `fn` as an anonymous deployment holding the operator App's deployment
 * secret, the only credential such a deployment has.
 */
export function asAnonymousDeployment(fn) {
  const secret = fixture().apps?.operator?.deployment_secret
  assert.ok(secret, "The fixture has no apps.operator.deployment_secret")
  configureSdk("anonymous")
  process.env.TRELLIS_APP_API_SECRET = secret
  return runWithRequest({ request: new Request("http://localhost/") }, fn)
}

function configureSdk(authMode) {
  process.env.TRELLIS_APP_API_URL = `${String(fixture().rails_url).replace(/\/+$/, "")}${API_PATH}`
  process.env.TRELLIS_APP_AUTH_MODE = authMode
  process.env.TRELLIS_APP_COOKIE_SIGNING_KEY ??= "ab".repeat(32)
  process.env.TRELLIS_APP_COOKIE_NAME_PREFIX ??= "e2e"
  if (authMode === "authenticated") delete process.env.TRELLIS_APP_API_SECRET
}

/** A short name unique to this run, like the Rails test's `uuid4().hex[:12]`. */
export function uniqueName(prefix) {
  return `${prefix} ${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
}

/** A YYYY-MM-DD date `days` days from today, in UTC. */
export function isoDateFromToday(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
}

/**
 * Asserts that `promise` rejects with a TrellisAppApiError whose status is
 * `status` (or one of them, given an array) and, when given,
 * `body.error === code` (or one of them). Returns the error.
 */
export async function assertApiError(promise, status, code) {
  let caught
  await assert.rejects(promise, (error) => {
    caught = error
    assert.ok(
      error instanceof sdk.TrellisAppApiError,
      `expected TrellisAppApiError, got ${error?.name}: ${error?.message}`
    )
    const statuses = [status].flat()
    assert.ok(
      statuses.includes(error.status),
      `expected status ${statuses.join(" or ")}, got ${error.status}: ${JSON.stringify(error.body)}`
    )
    if (code !== undefined) {
      const codes = [code].flat()
      assert.ok(
        codes.includes(error.body?.error),
        `expected error ${codes.join(" or ")}, got ${JSON.stringify(error.body)}`
      )
    }
    return true
  })
  return caught
}

/**
 * Calls `read` every `intervalMs` until `done(value)` is true, and returns
 * that value. Fails with `message` after `timeoutMs`.
 */
export async function pollUntil(read, done, { timeoutMs, intervalMs = 500, message }) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await read()
    if (done(last)) return last
    await new Promise((resolveSleep) => setTimeout(resolveSleep, intervalMs))
  }
  assert.fail(`${message}; last seen: ${JSON.stringify(last)}`)
}

/**
 * Runs `body`, then `cleanup`. When `body` succeeded, a cleanup failure fails
 * the test (cleanup asserts are part of the flow, as in the Rails test). When
 * `body` failed, cleanup is best effort, so its failure cannot mask the
 * original error.
 */
export async function withCleanup(body, cleanup) {
  let failed = true
  try {
    const result = await body()
    failed = false
    return result
  } finally {
    if (failed) {
      try {
        await cleanup()
      } catch (error) {
        console.warn(`cleanup after failure also failed: ${error?.status ?? ""} ${JSON.stringify(error?.body ?? error?.message)}`)
      }
    } else {
      await cleanup()
    }
  }
}
