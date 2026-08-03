import { request } from "./http.js"

const CONSTITUENT_PROPERTIES_PATH = "constituent-properties"

/**
 * A map of property key to the signed-in constituent's current value. Values are
 * typed per property: string, number, boolean, an ISO-8601 date/datetime string,
 * or an array of those. Keys that are unknown to the school, hidden behind the
 * property's authentication flag, or unset for this constituent are omitted from
 * the map, so read defensively (`props.foo ?? fallback`).
 */
export type ConstituentProperties = Record<string, unknown>

/**
 * Fetch the signed-in constituent's values for the given property keys.
 * Server-only.
 *
 * Works only when the signed-in subject is a constituent; the subject is taken
 * from the session, so there is no constituent-id argument. In a mixed-auth app,
 * gate the call on `getTrellisUser()?.subjectType === "constituent"`. Discover
 * valid keys with the `get_agent_schema` MCP tool (the
 * `constituent_properties[].key` values).
 *
 * @param keys - The property keys to read.
 * @throws {@link TrellisAppApiError} with `status` 422 and `body.error`
 * `not_a_constituent` when the signed-in subject is not a constituent.
 */
export async function getConstituentProperties(
  keys: string[]
): Promise<ConstituentProperties> {
  return request<ConstituentProperties>(CONSTITUENT_PROPERTIES_PATH, {
    method: "POST",
    body: { keys }
  })
}
