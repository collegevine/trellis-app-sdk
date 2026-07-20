import { request } from "./http.js"

const CONSTITUENT_PROPERTIES_PATH = "constituent-properties"

// A map of property key to the signed-in constituent's current value for that
// property. Values are typed per the property: string, number, boolean, an
// ISO-8601 date/datetime string, or an array of those. Requested keys that are
// unknown to the school, hidden behind the property's authentication flag, or
// unset for this constituent are omitted from the map.
export type ConstituentProperties = Record<string, unknown>

// Fetch the signed-in constituent's values for the given property keys. Only
// works when the signed-in subject is a constituent (check `subjectType` on
// getTrellisUser()); for any other subject it throws TrellisAppApiError with
// status 422 and a body whose `error` is "not_a_constituent".
//
// Server-only, like the rest of the SDK: call it from a loader, action, or
// resource route, never from client-rendered component code. It reads the
// constituent's access token from the request's session cookie, which must not
// reach the browser.
//
// Discover valid property keys with the get_agent_schema MCP tool
// (constituent_properties[].key).
export async function getConstituentProperties(
  keys: string[]
): Promise<ConstituentProperties> {
  return request<ConstituentProperties>(CONSTITUENT_PROPERTIES_PATH, {
    method: "POST",
    body: { keys }
  })
}
