// The Mission flows of the Rails `AppTaskMissionLifecycle` live test, run
// through the SDK as an App would. See e2e/support.mjs for the fixture.
//
// Rails test                                   This file
// test_workflow_mission_draft_to_deleted       "a workflow mission goes from draft..."
// test_task_mission_draft_to_finished          "a task mission goes from draft..."
// test_operator_and_app_team_permissions       "an operator outside the App's team..."
//   (mission half; the task half is in tasks.test.mjs)
// test_constituent_property_permissions_...    "constituent property permissions..."
//   (mission half; the task half is in tasks.test.mjs)
//
// Not reproduced: the Rails workflow test also posts a foreign `product_id`
// and expects Rails to ignore it. The SDK cannot send that field: the request
// body is built from named inputs only, which src/missions.test.ts checks.

import assert from "node:assert/strict"
import { test } from "node:test"
import {
  asActor,
  asOperator,
  assertApiError,
  fixture,
  hasActor,
  isoDateFromToday,
  pollUntil,
  sdk,
  uniqueName,
  withCleanup
} from "./support.mjs"

const STARTUP_TIMEOUT_MS = 30_000
const ACTIVATION_TIMEOUT_MS = 45_000

function workflowFields(name) {
  const f = fixture()
  return {
    channel: "email",
    name,
    instructions: "Remind the empty synthetic audience to review its checklist.",
    segmentUid: f.workflow_segment_uid,
    senderId: f.sender_id,
    permissionGroupId: f.team_id,
    endsAt: isoDateFromToday(45)
  }
}

function taskMissionFields(name) {
  const f = fixture()
  return {
    hostAgentId: f.host_agent_id,
    name,
    instructions: "Review the synthetic constituent records for enrollment questions.",
    segmentUid: f.task_mission_segment_uid,
    endsAt: isoDateFromToday(45)
  }
}

async function listedIds(actor, options) {
  const page = await asActor(actor, () => sdk.listMissions(options))
  return page.items.map((mission) => mission.id)
}

function waitForWorkflowLive(id) {
  return pollUntil(
    () => asOperator(() => sdk.getWorkflowMission(id)),
    (mission) => mission.status === "live",
    { timeoutMs: STARTUP_TIMEOUT_MS, message: `Workflow mission ${id} did not become live` }
  )
}

// A task mission runs as a task with the same id on its host agent.
function waitForTaskActivation(id) {
  return pollUntil(
    () => asOperator(() => sdk.getTask(fixture().host_agent_id, id)),
    (task) => Boolean(task.activation_completed_at) && (task.constituent_count ?? 0) > 0,
    {
      timeoutMs: ACTIVATION_TIMEOUT_MS,
      message: `Task mission ${id} did not activate constituent tasks`
    }
  )
}

test("a workflow mission goes from draft to live, pauses, resumes, and is deleted", {
  timeout: 180_000
}, async () => {
  const f = fixture()
  const options = await asOperator(() => sdk.getMissionOptions())
  assert.ok((options.host_agents ?? []).map((host) => host.id).includes(f.host_agent_id))
  assert.ok((options.senders.email ?? []).map((sender) => sender.id).includes(f.sender_id))

  const name = uniqueName("App live workflow")
  const created = await asOperator(() => sdk.createWorkflowMission(workflowFields(name)))
  const id = created.id
  assert.deepEqual([created.kind, created.name, created.status], ["workflow", name, "draft"])
  assert.equal(created.sender_id, f.sender_id)

  await withCleanup(
    async () => {
      assert.ok(
        (await listedIds("operator", { tab: "drafts", kind: "workflow", query: name })).includes(id)
      )
      assert.equal((await asOperator(() => sdk.getWorkflowMission(id))).status, "draft")

      const revisedName = `${name} revised`
      const updated = await asOperator(() => sdk.updateWorkflowMission(id, { name: revisedName }))
      assert.equal(updated.name, revisedName)
      assert.equal((await asOperator(() => sdk.getWorkflowMission(id))).name, revisedName)
      assert.deepEqual(
        (await asOperator(() => sdk.checkWorkflowMissionLaunch(id))).problems,
        []
      )

      const launched = await asOperator(() => sdk.launchWorkflowMission(id))
      assert.equal(launched.launch, "started")
      assert.ok(["launching", "live"].includes(launched.mission.status))

      await waitForWorkflowLive(id)
      assert.ok(
        (await listedIds("operator", { tab: "active", kind: "workflow", query: revisedName })).includes(id)
      )
      const paused = await asOperator(() => sdk.pauseWorkflowMission(id))
      assert.equal(paused.mission.status, "paused")
      assert.equal((await asOperator(() => sdk.getWorkflowMission(id))).status, "paused")

      const resumed = await asOperator(() => sdk.launchWorkflowMission(id))
      assert.equal(resumed.launch, "started")
      await waitForWorkflowLive(id)
    },
    async () => {
      assert.equal((await asOperator(() => sdk.pauseWorkflowMission(id))).mission.status, "paused")
      assert.equal((await asOperator(() => sdk.deleteWorkflowMission(id))).mission.id, id)
    }
  )

  await assertApiError(asOperator(() => sdk.getWorkflowMission(id)), 404)
})

test("a task mission goes from draft to live and is cancelled to finished", {
  timeout: 180_000
}, async () => {
  const f = fixture()
  const name = uniqueName("App live task mission")
  const created = await asOperator(() => sdk.createTaskMission(taskMissionFields(name)))
  const id = created.id
  assert.deepEqual([created.kind, created.name, created.status], ["task", name, "draft"])
  assert.equal(created.host_agent.id, f.host_agent_id)

  let cancelled
  await withCleanup(
    async () => {
      assert.ok(
        (await listedIds("operator", { tab: "drafts", kind: "task", query: name })).includes(id)
      )
      assert.equal((await asOperator(() => sdk.getTaskMission(id))).status, "draft")

      const revisedName = `${name} revised`
      const updated = await asOperator(() => sdk.updateTaskMission(id, { name: revisedName }))
      assert.equal(updated.name, revisedName)
      assert.equal((await asOperator(() => sdk.getTaskMission(id))).name, revisedName)
      assert.deepEqual((await asOperator(() => sdk.checkTaskMissionLaunch(id))).problems, [])

      const launched = await asOperator(() => sdk.launchTaskMission(id))
      assert.equal(launched.launch, "started")
      assert.ok(["launching", "live"].includes(launched.mission.status))

      const activated = await waitForTaskActivation(id)
      assert.equal(activated.status, "active")
      assert.equal((await asOperator(() => sdk.getTaskMission(id))).status, "live")
      assert.ok(
        (await listedIds("operator", { tab: "active", kind: "task", query: revisedName })).includes(id)
      )
    },
    async () => {
      cancelled = await asOperator(() => sdk.cancelTaskMission(id))
    }
  )

  assert.equal(cancelled.mission.status, "finished")
  assert.equal((await asOperator(() => sdk.getTaskMission(id))).status, "finished")
})

test("an operator outside the App's team cannot create a workflow mission or see host agents", {
  timeout: 60_000
}, async (t) => {
  if (!hasActor("no_team")) return t.skip("the fixture has no apps.no_team actor")
  const name = uniqueName("App denied workflow")

  await assertApiError(asActor("no_team", () => sdk.createWorkflowMission(workflowFields(name))), 404)

  assert.deepEqual(await listedIds("operator", { tab: "drafts", kind: "workflow", query: name }), [])
  const offered = await asActor("no_team", () => sdk.getMissionOptions())
  assert.deepEqual(offered.host_agents, [])
})

test("constituent property permissions intersect for workflow missions", {
  timeout: 60_000
}, async (t) => {
  if (!hasActor("property_granted")) return t.skip("the fixture has no apps.property_granted actor")
  const name = uniqueName("App property workflow")
  const goal = {
    type: "string_match",
    propertyKey: fixture().property_key,
    value: ["Contract test value"],
    negate: false
  }
  const fields = { ...workflowFields(name), goalFilters: [goal] }

  const mission = await asActor("property_granted", () => sdk.createWorkflowMission(fields))
  const id = mission.id
  assert.deepEqual(mission.goal_filters, [
    { type: goal.type, property_key: goal.propertyKey, value: goal.value, negate: goal.negate }
  ])

  await withCleanup(
    async () => {
      // The operator cannot read the property, so every route to the mission is closed.
      await assertApiError(asOperator(() => sdk.createWorkflowMission(fields)), 403)
      await assertApiError(asOperator(() => sdk.getWorkflowMission(id)), 403)
      await assertApiError(
        asOperator(() => sdk.updateWorkflowMission(id, { name: "Denied edit" })),
        403
      )
      assert.deepEqual(
        await listedIds("operator", { tab: "drafts", kind: "workflow", query: name }),
        []
      )
      assert.equal(
        (await asActor("property_granted", () => sdk.getWorkflowMission(id))).name,
        name
      )
    },
    async () => {
      await asActor("property_granted", () => sdk.deleteWorkflowMission(id))
    }
  )
})
