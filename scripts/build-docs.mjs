// Generate the single-page Markdown API reference the deploy-app agent fetches.
//
// TypeDoc (with typedoc-plugin-markdown) emits one file per entry point, so the
// two public entry points -- the package root and the `/auth/server` subpath --
// come out as separate files. This script runs TypeDoc, then stitches those two
// files into one `docs/index.md` where each module is a section headed by the
// import path a consumer actually uses. The result is a single URL that returns
// the whole API in one fetch.
//
// A `.nojekyll` file makes GitHub Pages serve the Markdown verbatim rather than
// running it through Jekyll, and a redirecting `index.html` points the site root
// at the Markdown so a bare Pages URL still resolves.

import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync, rmSync } from "node:fs"

const OUT_DIR = "docs"
const ROOT_MODULE = `${OUT_DIR}/index.md`
const AUTH_MODULE = `${OUT_DIR}/auth/server.md`

const INTRO = [
  "Server-side SDK for Trellis Apps. Every function here is server-only: call",
  "it from a route loader, action, or resource route, never from",
  "client-rendered component code. Data-source and database helpers are imported",
  "from the package root; `getTrellisUser` is imported from the `/auth/server`",
  "subpath. Any non-2xx response throws `TrellisAppApiError`."
].join(" ")

// Drop the leading H1 title TypeDoc emits for a module; each section gets its
// own import-path heading below.
function stripTitle(markdown) {
  return markdown.replace(/^#\s+.*\r?\n+/, "").trimEnd()
}

execFileSync("npx", ["--no-install", "typedoc"], { stdio: "inherit" })

const merged =
  [
    "# `@collegevine/trellis-app-sdk`",
    "",
    INTRO,
    "",
    stripTitle(readFileSync(ROOT_MODULE, "utf8")),
    "",
    "# `@collegevine/trellis-app-sdk/auth/server`",
    "",
    stripTitle(readFileSync(AUTH_MODULE, "utf8"))
  ].join("\n") + "\n"

writeFileSync(ROOT_MODULE, merged)
rmSync(`${OUT_DIR}/README.md`, { force: true })
rmSync(`${OUT_DIR}/auth`, { recursive: true, force: true })

writeFileSync(`${OUT_DIR}/.nojekyll`, "")
writeFileSync(
  `${OUT_DIR}/index.html`,
  '<!doctype html>\n<meta http-equiv="refresh" content="0; url=./index.md">\n'
)

console.log(`Wrote ${ROOT_MODULE} (single-page API reference)`)
