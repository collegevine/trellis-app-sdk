// The Task flows of the Rails `AppTaskMissionLifecycle` live test, run
// through the SDK as an App would. See e2e/support.mjs for the fixture.
//
// Rails test                                   This file
// test_regular_task_draft_to_cancelled         "a regular task goes from draft..."
// test_repeated_task_create_makes_distinct...  "repeated createTask calls..."
// test_operator_and_app_team_permissions       "neither the deployment secret nor..."
//   (task half; the mission half is in missions.test.mjs)
// test_constituent_property_permissions_...    "constituent property permissions..."
//   (task half; the mission half is in missions.test.mjs)

import assert from "node:assert/strict"
import { test } from "node:test"
import {
  asActor,
  asAnonymousDeployment,
  asOperator,
  assertApiError,
  fixture,
  hasActor,
  sdk,
  uniqueName,
  withCleanup,
  withToken
} from "./support.mjs"

const DAY_MS = 86_400_000
const hostAgent = () => fixture().host_agent_id

test("a regular task goes from draft to active to cancelled", { timeout: 120_000 }, async () => {
  const agent = hostAgent()
  const name = uniqueName("App live task")
  const start = new Date(Date.now() + 2 * DAY_MS)

  const created = await asOperator(() =>
    sdk.createTask(agent, {
      title: name,
      instructionText: "Review the synthetic enrollment queue.",
      startTime: start,
      endTime: new Date(start.getTime() + 7 * DAY_MS)
    })
  )
  const taskId = created.task_id
  assert.deepEqual([created.title, created.status], [name, "draft"])
  assert.equal(created.is_mission, false)

  await withCleanup(
    async () => {
      const listed = await asOperator(() => sdk.listTasks(agent, { limit: 200 }))
      assert.ok(listed.items.map((task) => task.task_id).includes(taskId))

      assert.equal((await asOperator(() => sdk.getTask(agent, taskId))).status, "draft")
      const updatedInstruction = "Review the synthetic queue and record next steps."
      const updated = await asOperator(() =>
        sdk.updateTask(agent, taskId, { instructionText: updatedInstruction })
      )
      assert.equal(updated.instruction_text, updatedInstruction)
      assert.equal(
        (await asOperator(() => sdk.getTask(agent, taskId))).instruction_text,
        updatedInstruction
      )

      const published = await asOperator(() => sdk.publishTask(agent, taskId))
      assert.equal(published.status, "active")
      assert.equal((await asOperator(() => sdk.getTask(agent, taskId))).status, "active")
    },
    async () => {
      const cancelled = await asOperator(() => sdk.cancelTask(agent, taskId))
      assert.equal(cancelled.status, "cancelled")
      assert.equal((await asOperator(() => sdk.getTask(agent, taskId))).status, "cancelled")
    }
  )
})

test("repeated createTask calls make distinct drafts", { timeout: 60_000 }, async () => {
  const agent = hostAgent()
  const fields = {
    title: uniqueName("App retry task"),
    instructionText: "Keep separate drafts for repeated create calls."
  }

  const first = await asOperator(() => sdk.createTask(agent, fields))
  const second = await asOperator(() => sdk.createTask(agent, fields))

  assert.notEqual(first.task_id, second.task_id)
  assert.deepEqual([first.status, second.status], ["draft", "draft"])
  for (const { task_id } of [first, second]) {
    assert.equal((await asOperator(() => sdk.getTask(agent, task_id))).title, fields.title)
    assert.equal((await asOperator(() => sdk.cancelTask(agent, task_id))).status, "cancelled")
  }
})

test("neither the deployment secret nor an operator outside the App's team can create a task", {
  timeout: 60_000
}, async (t) => {
  if (!hasActor("no_team")) return t.skip("the fixture has no apps.no_team actor")
  const agent = hostAgent()
  const fields = { title: uniqueName("App denied task"), instructionText: "Do not create this task." }
  const total = async () =>
    (await asOperator(() => sdk.listTasks(agent, { limit: 1 }))).meta.pagination?.total
  const before = await total()
  assert.ok(Number.isInteger(before), "listTasks meta must carry pagination.total")

  // An anonymous deployment's only credential is its deployment secret. The
  // SDK refuses before sending it, so no request reaches Rails.
  await assertApiError(
    asAnonymousDeployment(() => sdk.createTask(agent, fields)),
    401,
    "unauthorized"
  )
  // The same secret presented as a session token reaches Rails, which must
  // reject it as the Rails test does.
  await assertApiError(
    withToken(fixture().apps.operator.deployment_secret, () => sdk.createTask(agent, fields)),
    401
  )
  await assertApiError(asActor("no_team", () => sdk.createTask(agent, fields)), 403)

  assert.equal(await total(), before, "a rejected create must not add a task")
})

test("constituent property permissions intersect for tasks", { timeout: 60_000 }, async (t) => {
  if (!hasActor("property_granted")) return t.skip("the fixture has no apps.property_granted actor")
  const agent = hostAgent()
  const name = uniqueName("App property task")
  const additionalFilters = {
    id: "property_equality",
    property_key: fixture().property_key,
    values: ["Contract test value"]
  }
  const fields = {
    title: name,
    instructionText: "Review records with this synthetic filter.",
    startTime: new Date(Date.now() + 2 * DAY_MS),
    additionalFilters
  }

  const created = await asActor("property_granted", () => sdk.createTask(agent, fields))
  const taskId = created.task_id
  assert.deepEqual(created.additional_filters, additionalFilters)

  await withCleanup(
    async () => {
      // The operator cannot read the property, so every route to the task is closed.
      await assertApiError(asOperator(() => sdk.createTask(agent, fields)), 403)
      await assertApiError(asOperator(() => sdk.getTask(agent, taskId)), 403)
      await assertApiError(
        asOperator(() => sdk.updateTask(agent, taskId, { title: "Denied edit" })),
        403
      )
      const listed = await asOperator(() => sdk.listTasks(agent, { limit: 200 }))
      assert.ok(!listed.items.map((task) => task.task_id).includes(taskId))

      assert.equal((await asActor("property_granted", () => sdk.getTask(agent, taskId))).title, name)
      assert.equal(
        (await asActor("property_granted", () => sdk.publishTask(agent, taskId))).status,
        "active"
      )
    },
    async () => {
      assert.equal(
        (await asActor("property_granted", () => sdk.cancelTask(agent, taskId))).status,
        "cancelled"
      )
    }
  )
})
