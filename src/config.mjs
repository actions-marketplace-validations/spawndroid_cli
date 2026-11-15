/**
 * `spawndroid.yaml` — parse it strictly, and detect enough of a project to
 * write one without a questionnaire.
 *
 * Strict means unknown keys fail: a typo in CI config is silently expensive,
 * so `timeout` misspelled as `timout` must not fall back to the default.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { basename, join, relative } from "node:path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"

export const SPEC_FILE = "spawndroid.yaml"
export const DEVICE_ROOT = "/sdcard"
export const DEVICE_FILE_MAX_BYTES = 32 * 1024 * 1024
export const DEFAULT_TIMEOUT_SECONDS = 600

const SPEC_KEYS = [
  "version",
  "app",
  "profile",
  "command",
  "fixtures",
  "report",
  "timeout",
]

export class SpecError extends Error {
  constructor(problems) {
    super(problems.join("\n"))
    this.name = "SpecError"
    this.problems = problems
  }
}

/** `/sdcard` or a directory under it. Mirrors the console's device-path rule. */
export function devicePath(input) {
  if (typeof input !== "string") return null
  if (input.includes("\0") || input.includes("\\")) return null
  const trimmed = input.trim()
  if (!trimmed.startsWith("/")) return null
  const body = trimmed.replace(/\/+/g, "/").replace(/\/$/, "") || "/"
  if (body !== DEVICE_ROOT && !body.startsWith(`${DEVICE_ROOT}/`)) return null
  for (const segment of body.split("/").slice(1)) {
    if (!segment || segment === "." || segment === "..") return null
  }
  return body
}

/**
 * A string is split on whitespace for convenience; a list is exact argv.
 * Commands with quoting or shell syntax belong in the list form, e.g.
 * `command: [bash, -c, "mvn test && cp report.xml ."]`.
 */
function parseCommand(value, problems) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      problems.push(`"command" must not be empty`)
      return []
    }
    const argv = []
    for (const item of value) {
      if (typeof item !== "string" || item.trim() === "") {
        problems.push(`"command" must contain only non-empty strings`)
        return []
      }
      argv.push(item)
    }
    return argv
  }
  if (typeof value === "string") {
    const argv = value.trim().split(/\s+/).filter(Boolean)
    if (argv.length === 0) problems.push(`"command" must not be empty`)
    return argv
  }
  problems.push(`"command" must be a string or a list of strings`)
  return []
}

function parseFixtures(value, problems) {
  if (value == null) return []
  if (!Array.isArray(value)) {
    problems.push(`"fixtures" must be a list`)
    return []
  }
  const fixtures = []
  for (const item of value) {
    if (typeof item === "string") {
      fixtures.push({ local: item, device: `${DEVICE_ROOT}/Download` })
      continue
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      problems.push(`each fixture must be a path or { local, device }`)
      continue
    }
    const local = typeof item.local === "string" ? item.local.trim() : ""
    const device = devicePath(item.device)
    if (!local) problems.push(`a fixture is missing "local"`)
    if (!device) {
      problems.push(
        `fixture "${local || "?"}" needs "device": an absolute directory under ${DEVICE_ROOT}`
      )
      continue
    }
    if (local) fixtures.push({ local, device })
  }
  return fixtures
}

/**
 * Parse spec text into a normalized spec. Throws SpecError listing every
 * problem at once, so one run of `check` can name them all.
 */
export function parseSpec(text, { file = SPEC_FILE } = {}) {
  let doc
  try {
    doc = parseYaml(text)
  } catch (error) {
    throw new SpecError([`${file}: ${error.message}`])
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new SpecError([`${file}: expected a mapping with at least "version" and "app"`])
  }

  const problems = []
  for (const key of Object.keys(doc)) {
    if (!SPEC_KEYS.includes(key)) {
      problems.push(`unknown key "${key}" (allowed: ${SPEC_KEYS.join(", ")})`)
    }
  }
  if (doc.version !== 1) problems.push(`"version" must be 1`)

  const app = typeof doc.app === "string" ? doc.app.trim() : ""
  if (!app) problems.push(`"app" is required — an APK path or an uploaded app slug`)

  const profile =
    doc.profile == null
      ? null
      : typeof doc.profile === "string" && doc.profile.trim()
        ? doc.profile.trim()
        : (problems.push(`"profile" must be a non-empty string`), null)

  const command = parseCommand(doc.command, problems)
  const fixtures = parseFixtures(doc.fixtures, problems)

  const report =
    doc.report == null
      ? null
      : typeof doc.report === "string" && doc.report.trim()
        ? doc.report.trim()
        : (problems.push(`"report" must be a path to a JUnit XML file`), null)

  let timeout = DEFAULT_TIMEOUT_SECONDS
  if (doc.timeout != null) {
    if (!Number.isInteger(doc.timeout) || doc.timeout <= 0 || doc.timeout > 3600) {
      problems.push(`"timeout" must be whole seconds between 1 and 3600`)
    } else {
      timeout = doc.timeout
    }
  }

  if (problems.length) throw new SpecError(problems)
  return { version: 1, app, profile, command, fixtures, report, timeout }
}

export function loadSpec(path) {
  let text
  try {
    text = readFileSync(path, "utf8")
  } catch {
    throw new SpecError([
      `no ${basename(path)} found — run \`spawndroid init\` to create one`,
    ])
  }
  return parseSpec(text, { file: basename(path) })
}

/** Render a spec object to YAML text with a stable key order. */
export function specText(spec) {
  const doc = { version: 1, app: spec.app }
  if (spec.profile) doc.profile = spec.profile
  doc.command = spec.command.length === 1 ? spec.command[0] : spec.command
  if (spec.report) doc.report = spec.report
  if (spec.timeout !== DEFAULT_TIMEOUT_SECONDS) doc.timeout = spec.timeout
  if (spec.fixtures.length) doc.fixtures = spec.fixtures
  return stringifyYaml(doc, { lineWidth: 0 })
}

/* ------------------------------------------------------------------ */
/* Project detection                                                   */
/* ------------------------------------------------------------------ */

const file = (path) => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
const read = (path) => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}
const list = (path) => {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/** `<module>/build/outputs/apk/debug/*.apk` for the project root and its children. */
function findBuiltApk(dir) {
  const bases = [dir, ...list(dir).filter((entry) => !entry.startsWith(".")).map((entry) => join(dir, entry))]
  for (const base of bases) {
    const debugDir = join(base, "build", "outputs", "apk", "debug")
    for (const name of list(debugDir)) {
      if (name.endsWith(".apk")) return join(debugDir, name)
    }
  }
  return null
}

/** Gradle application module from settings.gradle(.kts) include() lines. */
function gradleAppModule(dir) {
  const settings = read(join(dir, "settings.gradle.kts")) ?? read(join(dir, "settings.gradle"))
  if (!settings) return null
  const modules = [...settings.matchAll(/include\(\s*["']([^"']+)["']\s*\)/g)]
    .map((match) => match[1].replace(/^:/, ""))
  for (const modulePath of modules) {
    const name = modulePath.split(":").pop()
    for (const buildFile of ["build.gradle.kts", "build.gradle"]) {
      if ((read(join(dir, modulePath, buildFile)) ?? "").includes("com.android.application")) {
        return { module: modulePath, name }
      }
    }
  }
  return null
}

function detectApp(dir) {
  const built = findBuiltApk(dir)
  if (built) return { app: relative(dir, built), note: null }
  const gradle = gradleAppModule(dir)
  if (gradle) {
    return {
      app: join(gradle.module, "build", "outputs", "apk", "debug", `${gradle.name}-debug.apk`),
      note: `expected APK for Gradle module "${gradle.module}" — build it before the first run`,
    }
  }
  return { app: null, note: null }
}

function detectStack(dir) {
  const packageJson = read(join(dir, "package.json"))
  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson)
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
      const conf = ["wdio.conf.mjs", "wdio.conf.js", "wdio.conf.ts", "wdio.conf.cjs"].find(
        (name) => file(join(dir, name))
      )
      if (deps.webdriverio || conf) {
        return { stack: "node", command: ["npx", "wdio", "run", conf ?? "wdio.conf.js"] }
      }
    } catch {
      /* malformed package.json is the user's build's problem, not init's */
    }
  }
  if (file(join(dir, "pom.xml"))) {
    return { stack: "maven", command: ["mvn", "test"] }
  }
  const requirements = read(join(dir, "requirements.txt")) ?? ""
  if (/appium/i.test(requirements) || file(join(dir, "pytest.ini"))) {
    return { stack: "python", command: ["pytest", "-q"] }
  }
  const gradle = read(join(dir, "settings.gradle.kts")) ?? read(join(dir, "settings.gradle"))
  if (gradle) {
    return { stack: "gradle", command: ["./gradlew", "test"] }
  }
  return { stack: null, command: null }
}

function detectReport(dir, stack, command) {
  if (stack === "maven") {
    const reports = list(join(dir, "target", "surefire-reports")).filter((name) =>
      name.endsWith(".xml")
    )
    if (reports.length === 1) return { report: join("target", "surefire-reports", reports[0]), note: null }
    if (reports.length > 1) {
      return {
        report: null,
        note: `${reports.length} JUnit files in target/surefire-reports — set "report" to one of them`,
      }
    }
  }
  if (stack === "node" && file(join(dir, "reports", "junit.xml"))) {
    return { report: join("reports", "junit.xml"), note: null }
  }
  if (stack === "python") {
    return {
      report: null,
      note: "add --junitxml=junit.xml to the pytest command, then set \"report\": junit.xml",
    }
  }
  if (stack === "gradle") {
    return {
      report: null,
      note: "Gradle writes build/test-results/test — pick one TEST-*.xml and set \"report\"",
    }
  }
  void command
  return { report: null, note: null }
}

/** Setup steps the generated workflow needs before running the tests. */
function setupSteps(dir, stack) {
  if (stack === "maven" || stack === "gradle") {
    return [
      {
        uses: "actions/setup-java@v4",
        with: { "distribution": "temurin", "java-version": "17" },
      },
    ]
  }
  if (stack === "python") {
    return [
      { uses: "actions/setup-python@v5", with: { "python-version": "3.12" } },
      { name: "Install dependencies", run: "pip install -r requirements.txt" },
    ]
  }
  if (stack === "node") {
    const steps = [
      { uses: "actions/setup-node@v4", with: { "node-version": "22" } },
    ]
    if (file(join(dir, "pnpm-lock.yaml"))) {
      steps.push({ uses: "pnpm/action-setup@v4" })
      steps.push({ name: "Install dependencies", run: "pnpm install --frozen-lockfile" })
    } else if (file(join(dir, "yarn.lock"))) {
      steps.push({ name: "Install dependencies", run: "yarn install --frozen-lockfile" })
    } else {
      steps.push({ name: "Install dependencies", run: "npm ci" })
    }
    return steps
  }
  return []
}

/**
 * Inspect a project to pre-fill the spec. Everything it returns is a guess;
 * `init` prints each value before writing so the guess is visible.
 */
export function detectProject(dir) {
  const app = detectApp(dir)
  const { stack, command } = detectStack(dir)
  const report = detectReport(dir, stack, command)
  return {
    stack,
    app: app.app,
    appNote: app.note,
    command,
    report: report.report,
    reportNote: report.note,
    setup: setupSteps(dir, stack),
  }
}

/* ------------------------------------------------------------------ */
/* Workflow generation                                                 */
/* ------------------------------------------------------------------ */

function stepLines(step) {
  if (step.uses) {
    const lines = [`      - uses: ${step.uses}`]
    if (step.with) {
      lines.push("        with:")
      for (const [key, value] of Object.entries(step.with)) {
        lines.push(`          ${key}: ${value}`)
      }
    }
    return lines
  }
  return [`      - name: ${step.name}`, `        run: ${step.run}`]
}

export function workflowText({ setup, version, specFile = SPEC_FILE }) {
  const lines = [
    "name: spawndroid",
    "on:",
    "  pull_request:",
    "",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 30",
    "    steps:",
    "      - uses: actions/checkout@v4",
  ]
  for (const step of setup ?? []) lines.push(...stepLines(step))
  lines.push(
    "      - name: Run Android tests",
    `        run: npx --yes spawndroid@${version} run --config ${specFile}`,
    "        env:",
    "          SPAWNDROID_API_KEY: ${{ secrets.SPAWNDROID_API_KEY }}",
    ""
  )
  return lines.join("\n")
}
