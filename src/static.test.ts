import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FetchHandler } from "./lambda.js"
import { withStaticAssets } from "./static.js"

const ORIGIN = "https://x-wing.dagobah.apps.collegevine.ai"

describe("withStaticAssets", () => {
  let clientDir: string
  let fallthrough: ReturnType<typeof vi.fn<FetchHandler>>
  let handler: FetchHandler

  beforeEach(async () => {
    clientDir = await mkdtemp(join(tmpdir(), "trellis-static-"))
    await mkdir(join(clientDir, "assets"), { recursive: true })
    await writeFile(
      join(clientDir, "assets", "entry.client-Ab1Cd2Ef.js"),
      "console.log('these are not the droids')"
    )
    await writeFile(join(clientDir, "favicon.ico"), Buffer.from([0x00, 0x01]))
    fallthrough = vi.fn<FetchHandler>(async () => new Response("ssr", { status: 200 }))
    handler = withStaticAssets(clientDir, fallthrough)
  })

  afterEach(async () => {
    await rm(clientDir, { recursive: true, force: true })
  })

  it("serves hashed asset bundles with an immutable cache and a JS content type", async () => {
    const response = await handler(
      new Request(`${ORIGIN}/assets/entry.client-Ab1Cd2Ef.js`)
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8"
    )
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable"
    )
    expect(await response.text()).toBe("console.log('these are not the droids')")
    expect(fallthrough).not.toHaveBeenCalled()
  })

  it("serves non-hashed client files with a short cache TTL", async () => {
    const response = await handler(new Request(`${ORIGIN}/favicon.ico`))

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("image/x-icon")
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600")
  })

  it("returns headers without a body for HEAD requests", async () => {
    const response = await handler(
      new Request(`${ORIGIN}/assets/entry.client-Ab1Cd2Ef.js`, { method: "HEAD" })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8"
    )
    expect(await response.text()).toBe("")
  })

  it("falls through to the app handler for routes, directories, and missing files", async () => {
    for (const path of ["/", "/assets", "/assets/missing.js", "/x-wings"]) {
      const response = await handler(new Request(`${ORIGIN}${path}`))
      expect(await response.text()).toBe("ssr")
    }
    expect(fallthrough).toHaveBeenCalledTimes(4)
  })

  it("falls through for non-GET methods even when the path matches a file", async () => {
    const response = await handler(
      new Request(`${ORIGIN}/favicon.ico`, { method: "POST", body: "r2d2" })
    )

    expect(await response.text()).toBe("ssr")
  })

  it("refuses to serve files outside the client directory via encoded traversal", async () => {
    await writeFile(join(clientDir, "..", "death-star-plans.txt"), "secret")

    // "../" segments survive URL normalization only when percent-encoded;
    // a raw "/assets/../../death-star-plans.txt" is collapsed by new URL()
    // before it ever reaches the wrapper.
    const response = await handler(
      new Request(`${ORIGIN}/assets/%2e%2e/%2e%2e/death-star-plans.txt`)
    )

    expect(await response.text()).toBe("ssr")
    await rm(join(clientDir, "..", "death-star-plans.txt"), { force: true })
  })
})
