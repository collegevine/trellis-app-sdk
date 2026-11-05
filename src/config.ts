import { request } from "./http.js"

const CONFIG_VALUES_PATH = "config-values"

let configValues: Promise<Record<string, string>> | undefined

/**
 * The config values the app was deployed with: the `config_values` passed to
 * the `deploy_app` MCP tool, including those kept from earlier deploys. Every
 * value is a string. They may hold secrets, so keep them on the server.
 * Server-only.
 *
 * Fetched from the platform on the first call and cached for the life of the
 * process, since they only change with a new deployment. A failed fetch is not
 * cached, so the next call tries again. A key the app was never deployed with
 * is absent, so read defensively (`(await getAppConfig()).PROGRAM ?? fallback`).
 *
 * @throws {@link TrellisAppApiError} when the platform cannot be reached.
 */
export function getAppConfig(): Promise<Record<string, string>> {
  configValues ??= request<Record<string, string>>(CONFIG_VALUES_PATH, {
    withDeploymentSecret: true
  }).catch((error: unknown) => {
    configValues = undefined
    throw error
  })
  return configValues
}
