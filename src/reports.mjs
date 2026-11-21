/**
 * Finding the JUnit XML a test command wrote, so a run carries a report
 * without the user naming one file. Gradle writes one file per test class,
 * so "point at one file" left most Android projects without a report.
 *
 * Plain fs on purpose: the CLI supports Node 20, which has no fs.glob.
 */

import { readdir, stat } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"

/** Directories never worth walking: dependencies and tool caches. */
const SKIP = new Set(["node_modules", ".git", ".gradle", ".idea", ".venv", "venv"])

/** Where JUnit-writing build tools put reports when nobody configures them. */
const DEFAULT_PATTERNS = [
  "**/build/test-results/**/*.xml",
  "**/build/outputs/androidTest-results/**/*.xml",
  "**/target/surefire-reports/*.xml",
]

const MAX_DEPTH = 12

/**
 * The report files to attach, as absolute paths, sorted.
 *
 * - `report` a file: that file (if it exists).
 * - `report` a directory: every `.xml` inside it, recursively.
 * - `report` containing `*`: every file matching it (`*` within a path
 *   segment, `**` across segments), relative to `dir`.
 * - `report` null: the default build-tool locations, keeping only files
 *   modified at or after `since`, so a stale report from an earlier build is
 *   never attached to this run.
 */
export async function collectReports({ dir, report, since = 0 }) {
  if (report) {
    if (report.includes("*")) return matchPattern(dir, report, 0)
    const path = resolve(dir, report)
    const info = await stat(path).catch(() => null)
    if (!info) return []
    if (info.isFile()) return [path]
    if (info.isDirectory()) return (await walk(path)).filter((file) => file.endsWith(".xml")).sort()
    return []
  }
  const found = new Set()
  for (const pattern of DEFAULT_PATTERNS) {
    for (const file of await matchPattern(dir, pattern, since)) found.add(file)
  }
  return [...found].sort()
}

/**
 * One JUnit document from several. The console counts every `<testcase>`
 * in the body, so suites can sit side by side under one `<testsuites>`.
 */
export function mergeJUnit(documents) {
  if (documents.length === 1) return documents[0]
  const bodies = documents.map((xml) => xml.replace(/<\?xml[^>]*\?>\s*/g, "").trim())
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${bodies.join("\n")}\n</testsuites>\n`
}

async function matchPattern(dir, pattern, since) {
  const regex = patternRegex(pattern)
  const files = await walk(dir)
  const matched = []
  for (const file of files) {
    const rel = relative(dir, file).split(sep).join("/")
    if (!regex.test(rel)) continue
    if (since) {
      const info = await stat(file).catch(() => null)
      if (!info || info.mtimeMs < since) continue
    }
    matched.push(file)
  }
  return matched.sort()
}

/** `**` spans segments (including none), `*` stays inside one segment. */
function patternRegex(pattern) {
  let source = ""
  const parts = pattern.split("/")
  parts.forEach((part, index) => {
    const last = index === parts.length - 1
    if (part === "**") {
      source += last ? ".*" : "(?:[^/]+/)*"
      return
    }
    source += part
      .split("*")
      .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*")
    if (!last) source += "/"
  })
  return new RegExp(`^${source}$`)
}

async function walk(root, depth = 0) {
  if (depth > MAX_DEPTH) return []
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const files = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) files.push(...(await walk(path, depth + 1)))
    } else if (entry.isFile()) {
      files.push(path)
    }
  }
  return files
}
