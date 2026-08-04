// Generate the single-page Markdown API reference the deploy-app agent fetches.
//
// TypeDoc (with typedoc-plugin-markdown) emits one Markdown file per entry
// point. This script reads the entry-point list straight from typedoc.json,
// runs TypeDoc, then stitches those files into one `docs/index.md` where each
// module is a section headed by the import path a consumer actually uses. The
// result is a single URL that returns the whole API in one fetch. Adding or
// removing an entry point in typedoc.json is picked up here with no change.
//
// A `.nojekyll` file makes GitHub Pages serve the Markdown verbatim rather than
// running it through Jekyll, and a redirecting `index.html` points the site root
// at the Markdown so a bare Pages URL still resolves.

import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync, rmSync } from "node:fs"

const typedocConfig = JSON.parse(readFileSync("typedoc.json", "utf8"))
const OUT_DIR = typedocConfig.out ?? "docs"
const ENTRY_POINTS = typedocConfig.entryPoints
const PACKAGE_NAME = JSON.parse(readFileSync("package.json", "utf8")).name

// The package root barrel. Its section leads the document and carries the
// intro, and its import path is the bare package name.
const ROOT_MODULE = "index"
const MERGED_FILE = `${OUT_DIR}/${ROOT_MODULE}.md`

const INTRO = [
  "Server-side SDK for Trellis Apps. Every function here is server-only: call",
  "it from a route loader, action, or resource route, never from",
  "client-rendered component code. Data-source and database helpers are imported",
  "from the package root; `getTrellisUser` is imported from the `/auth/server`",
  "subpath. Any non-2xx response throws `TrellisAppApiError`."
].join(" ")

// TypeDoc names each module by its path relative to the common parent directory
// of all entry points, extension dropped (so `src/auth/server.ts` becomes
// `auth/server`, written to `<out>/auth/server.md`). Mirror that naming so we
// can find the file TypeDoc wrote for each entry point.
function moduleNames(entryPoints) {
  const paths = entryPoints.map((p) => p.replace(/\.[cm]?tsx?$/, "").split("/"))
  let common = 0
  while (paths.every((p) => common < p.length - 1 && p[common] === paths[0][common])) common++
  return paths.map((p) => p.slice(common).join("/"))
}

// Drop the leading H1 title TypeDoc emits for a module; each section gets its
// own import-path heading below.
function stripTitle(markdown) {
  return markdown.replace(/^#\s+.*\r?\n+/, "").trimEnd()
}

function importPath(moduleName) {
  return moduleName === ROOT_MODULE ? PACKAGE_NAME : `${PACKAGE_NAME}/${moduleName}`
}

const modules = moduleNames(ENTRY_POINTS)
const ordered = modules.includes(ROOT_MODULE)
  ? [ROOT_MODULE, ...modules.filter((m) => m !== ROOT_MODULE)]
  : modules

execFileSync("npx", ["--no-install", "typedoc"], { stdio: "inherit" })

const merged =
  ordered
    .flatMap((name, i) => {
      const body = stripTitle(readFileSync(`${OUT_DIR}/${name}.md`, "utf8"))
      const intro = i === 0 ? [INTRO, ""] : []
      return [`# \`${importPath(name)}\``, "", ...intro, body, ""]
    })
    .join("\n")
    .trimEnd() + "\n"

writeFileSync(MERGED_FILE, merged)

// Remove the standalone files TypeDoc produced: its modules index (README.md)
// and every per-entry-point file now folded into MERGED_FILE, along with any
// subdirectory those files lived in.
rmSync(`${OUT_DIR}/README.md`, { force: true })
const subdirs = new Set()
for (const name of ordered) {
  if (name === ROOT_MODULE) continue
  if (name.includes("/")) subdirs.add(name.split("/")[0])
  else rmSync(`${OUT_DIR}/${name}.md`, { force: true })
}
for (const dir of subdirs) rmSync(`${OUT_DIR}/${dir}`, { recursive: true, force: true })

writeFileSync(`${OUT_DIR}/.nojekyll`, "")
writeFileSync(
  `${OUT_DIR}/index.html`,
  '<!doctype html>\n<meta http-equiv="refresh" content="0; url=./index.md">\n'
)

console.log(`Wrote ${MERGED_FILE} (single-page API reference)`)
