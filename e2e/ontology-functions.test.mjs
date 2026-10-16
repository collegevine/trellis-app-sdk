import assert from "node:assert/strict"
import { test } from "node:test"
import * as sdk from "../dist/index.js"
import { SESSION_COOKIE } from "../dist/auth/cookies.js"
import { runWithRequest } from "../dist/context.js"

const API_URL =
  process.env.TRELLIS_E2E_API_URL ??
  "http://localhost:3000/trellis/apps/api/v1/"

const FUNCTION = {
  dataSchema: process.env.TRELLIS_E2E_FUNCTION_SCHEMA ?? "ontology_v2",
  key: process.env.TRELLIS_E2E_FUNCTION_KEY ?? "person_label"
}
const HYPOTHETICAL_ARG = process.env.TRELLIS_E2E_HYPOTHETICAL_ARG ?? "first"
const CONSTITUENT_ID = 1

test("a published function evaluates with real data and with a hypothetical replacement", {
  timeout: 60_000
}, async () => {
  assert.equal(typeof sdk.evaluateFunction, "function", "SDK must export evaluateFunction")

  const { request, subjectId } = setUp()
  const hypothetical = `SDK e2e ${Date.now()}`

  const real = await runWithRequest({ request }, () =>
    sdk.evaluateFunction({
      function: FUNCTION,
      arguments: { subject: subjectId },
      constituentId: CONSTITUENT_ID
    })
  )
  console.info(`real=${JSON.stringify(real)}`)
  assertEvaluation(real, subjectId)
  assert.equal("hypotheticals" in real, false, "real-data evaluation must not echo hypotheticals")

  const replaced = await runWithRequest({ request }, () =>
    sdk.evaluateFunction({
      function: FUNCTION,
      arguments: { subject: subjectId, hypotheticals: { [HYPOTHETICAL_ARG]: hypothetical } },
      constituentId: CONSTITUENT_ID
    })
  )
  console.info(`hypothetical=${JSON.stringify(replaced)}`)
  assertEvaluation(replaced, subjectId)
  assert.deepEqual(replaced.hypotheticals, { [HYPOTHETICAL_ARG]: hypothetical })
  assert.notDeepEqual(
    replaced.result,
    real.result,
    "replacing an argument the result depends on must change the result"
  )
})

test("an undeclared hypothetical argument is rejected with FUNCTION_HYPOTHETICALS_INVALID", {
  timeout: 30_000
}, async () => {
  const { request, subjectId } = setUp()

  await assert.rejects(
    runWithRequest({ request }, () =>
      sdk.evaluateFunction({
        function: FUNCTION,
        arguments: { subject: subjectId, hypotheticals: { not_a_declared_argument: 1 } },
        constituentId: CONSTITUENT_ID
      })
    ),
    (error) => {
      assert.ok(error instanceof sdk.TrellisAppApiError)
      assert.equal(error.status, 422)
      assert.equal(error.body?.error, "functions_error")
      assert.equal(error.body?.details?.code, "FUNCTION_HYPOTHETICALS_INVALID")
      return true
    }
  )
})

function setUp() {
  const accessToken = process.env.TRELLIS_E2E_ACCESS_TOKEN
  assert.ok(accessToken, "Set TRELLIS_E2E_ACCESS_TOKEN to a valid staff tau_ token")
  const subjectId = process.env.TRELLIS_E2E_SUBJECT_ID?.trim()
  assert.ok(subjectId, "Set TRELLIS_E2E_SUBJECT_ID to the function subject's entity key")

  process.env.TRELLIS_APP_API_URL = API_URL
  process.env.TRELLIS_APP_AUTH_MODE = "authenticated"
  process.env.TRELLIS_APP_COOKIE_SIGNING_KEY ??= "ab".repeat(32)
  process.env.TRELLIS_APP_COOKIE_NAME_PREFIX ??= "e2e"

  const session = {
    accessToken,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    user: { name: "Monza test staff", emailHashes: [], subjectType: "school_user" }
  }
  const request = new Request("http://localhost:3000/", {
    headers: {
      cookie: sdk.signedCookieHeader({
        name: SESSION_COOKIE,
        value: session,
        maxAgeSeconds: 300
      }).split(";")[0]
    }
  })
  return { request, subjectId }
}

function assertEvaluation(evaluation, subjectId) {
  assert.equal(evaluation.function, FUNCTION.key)
  assert.equal(Number.isInteger(evaluation.rev), true)
  assert.equal(String(evaluation.subject), subjectId)
  assert.equal("result" in evaluation, true, "evaluation must carry a result key")
}
