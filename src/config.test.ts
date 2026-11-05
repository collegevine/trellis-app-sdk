import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const BASE_URL = "https://api.example.com/trellis/apps/api/v1/"
const SECRET = "tas_i-solemnly-swear"
const CONFIG_VALUES = { HOUSE: "Ravenclaw", PASSWORD: "Wit beyond measure" }

const fetchMock = vi.fn()

beforeEach(() => {
  // A fresh module each test resets the process-wide cache.
  vi.resetModules()
  vi.stubGlobal("fetch", fetchMock)
  vi.stubEnv("TRELLIS_APP_API_URL", BASE_URL)
  vi.stubEnv("TRELLIS_APP_API_SECRET", SECRET)
  fetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function loadGetAppConfig() {
  return (await import("../src/index.js")).getAppConfig
}

describe("getAppConfig", () => {
  it("fetches the config values once with the deployment secret, even in authenticated mode", async () => {
    vi.stubEnv("TRELLIS_APP_AUTH_MODE", "authenticated")
    fetchMock.mockResolvedValue(jsonResponse(200, { data: CONFIG_VALUES }))
    const getAppConfig = await loadGetAppConfig()

    expect(await Promise.all([getAppConfig(), getAppConfig()])).toEqual([CONFIG_VALUES, CONFIG_VALUES])
    expect(await getAppConfig()).toEqual(CONFIG_VALUES)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}config-values`)
    expect(init.method).toBe("GET")
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`)
  })

  it("does not cache a failure, so the next call tries again", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(503, { error: "service_unavailable" }))
      .mockResolvedValueOnce(jsonResponse(200, { data: CONFIG_VALUES }))
    const getAppConfig = await loadGetAppConfig()

    await expect(getAppConfig()).rejects.toMatchObject({ status: 503 })
    expect(await getAppConfig()).toEqual(CONFIG_VALUES)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  })
}
