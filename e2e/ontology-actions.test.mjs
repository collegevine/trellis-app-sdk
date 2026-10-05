import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import * as sdk from "../dist/index.js"
import { encodeCookie, SESSION_COOKIE } from "../dist/auth/cookies.js"
import { runWithRequest } from "../dist/context.js"

const API_URL =
  process.env.TRELLIS_E2E_API_URL ??
  "http://localhost:3000/trellis/apps/api/v1/"
const BANNER_REQUESTS_URL =
  process.env.TRELLIS_E2E_BANNER_REQUESTS_URL ??
  "http://localhost:8089/requests"

const ACTION = { dataSchema: "ontology_v1", key: "app_contract_post_note" }
const CONSTITUENT_ID = 1

test("the Monza Action reaches Banner once and deduplicates a repeated submission", {
  timeout: 60_000
}, async () => {
  assert.equal(typeof sdk.executeAction, "function", "SDK must export executeAction")

  const accessToken = process.env.TRELLIS_E2E_ACCESS_TOKEN
  assert.ok(accessToken, "Set TRELLIS_E2E_ACCESS_TOKEN to a valid staff tau_ token")
  const subjectId = process.env.TRELLIS_E2E_SUBJECT_ID?.trim()
  assert.ok(subjectId, "Set TRELLIS_E2E_SUBJECT_ID to the seeded Banner person ID")

  process.env.TRELLIS_APP_API_URL = API_URL
  process.env.TRELLIS_APP_AUTH_MODE = "authenticated"

  const submission = randomUUID()
  console.info(`submission=${submission}`)
  const input = {
    action: ACTION,
    arguments: {
      subject: subjectId,
      params: { note: "SDK end-to-end test", submission },
      idempotencyKey: submission
    },
    constituentId: CONSTITUENT_ID
  }
  const session = {
    accessToken,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    user: { name: "Monza test staff", emailHashes: [], subjectType: "school_user" }
  }
  const request = new Request("http://localhost:3000/", {
    headers: { cookie: `${SESSION_COOKIE}=${encodeCookie(session)}` }
  })

  assert.equal((await matchingBannerRequests(submission)).length, 0)

  const first = await runWithRequest({ request }, () => sdk.executeAction(input))
  console.info(`first_receipt=${JSON.stringify(first)}`)
  assertReceipt(first)
  assert.equal(first.action, ACTION.key)
  assert.equal(first.rev, 1)
  assert.equal(first.deduped, false)
  assert.ok(
    !first.complete || first.succeeded,
    `Action completed unsuccessfully: ${JSON.stringify(first)}`
  )

  await waitForBannerRequest(submission)

  const second = await runWithRequest({ request }, () => sdk.executeAction(input))
  console.info(`deduplicated_receipt=${JSON.stringify(second)}`)
  assertReceipt(second)
  assert.equal(second.action, ACTION.key)
  assert.equal(second.rev, 1)
  assert.equal(second.deduped, true)

  await new Promise((resolve) => setTimeout(resolve, 500))
  const matches = await matchingBannerRequests(submission)
  console.info(`banner_request_count=${matches.length}`)
  assert.equal(matches.length, 1, "one idempotency key must cause one Banner request")
  assert.equal(matches[0].authenticated, true)
  assert.equal(matches[0].body.person_id, subjectId)
})

function assertReceipt(receipt) {
  assert.match(
    receipt.invocation,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  )
  assert.equal(typeof receipt.state, "string")
  assert.equal(typeof receipt.complete_at, "string")
  assert.equal(typeof receipt.complete, "boolean")
  assert.equal(typeof receipt.succeeded, "boolean")
  assert.equal(typeof receipt.deduped, "boolean")
  assert.equal(typeof receipt.guarantee, "string")
}

async function matchingBannerRequests(submission) {
  const response = await fetch(BANNER_REQUESTS_URL)
  assert.equal(response.ok, true, `Banner fixture returned HTTP ${response.status}`)
  const requests = await response.json()
  assert.ok(Array.isArray(requests), "Banner fixture must return an array")
  return requests.filter((request) => request?.body?.submission === submission)
}

async function waitForBannerRequest(submission) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if ((await matchingBannerRequests(submission)).length > 0) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  assert.fail("Timed out waiting for the matching Banner request")
}
