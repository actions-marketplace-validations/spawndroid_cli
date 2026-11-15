/**
 * `spawndroid init` — detect the project, ask only for the gaps, write the
 * spec and a workflow. Detection first, questionnaire never.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline/promises"

import {
  DEFAULT_TIMEOUT_SECONDS,
  SpecError,
  detectProject,
  specText,
  workflowText,
} from "./config.mjs"

const WORKFLOW_PATH = join(".github", "workflows", "spawndroid.yml")

function splitCommand(value) {
  return value.trim().split(/\s+/).filter(Boolean)
}

function makeAsker(interactive) {
  return async (question, fallback) => {
    if (!interactive) return fallback ?? null
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    try {
      const shown = fallback ? `${question} [${fallback}]: ` : `${question}: `
      const answer = (await rl.question(shown)).trim()
      return answer || fallback || null
    } finally {
      rl.close()
    }
  }
}

export async function runInit({
  dir,
  configPath,
  flags,
  version,
  stdout = (...args) => console.log(...args),
  stderr = (...args) => console.error(...args),
  interactive = Boolean(process.stdin.isTTY),
}) {
  const detection = detectProject(dir)
  const ask = makeAsker(interactive)

  const app =
    flags.app ?? detection.app ?? (await ask("Path to the APK to upload", null))
  const commandValue =
    flags.command ?? (detection.command ? detection.command.join(" ") : null)
  const command = commandValue ?? (await ask("Test command (e.g. mvn test)", null))
  const report = flags.report ?? detection.report ?? ""
  const profile = flags.profile ?? ""
  const timeout = flags.timeout ? Number(flags.timeout) : DEFAULT_TIMEOUT_SECONDS

  const problems = []
  if (!app) problems.push("an APK path is required — pass --app <path>")
  if (!command) problems.push('a test command is required — pass --command "mvn test"')
  if (!Number.isInteger(timeout) || timeout <= 0) problems.push("--timeout must be whole seconds")
  if (problems.length) throw new SpecError(problems)

  const spec = {
    version: 1,
    app,
    profile: profile || null,
    command: splitCommand(command),
    fixtures: [],
    report: report || null,
    timeout,
  }

  stdout("spawndroid init")
  stdout(`  app      ${app}${detection.appNote ? `  (${detection.appNote})` : ""}`)
  stdout(`  command  ${spec.command.join(" ")}`)
  stdout(`  report   ${spec.report ?? "none"}`)
  stdout(`  profile  ${spec.profile ?? "default"}`)
  if (detection.reportNote) stderr(`note: ${detection.reportNote}`)

  if (existsSync(configPath) && !flags.force) {
    throw new SpecError([`${configPath} already exists — pass --force to overwrite`])
  }
  writeFileSync(configPath, specText(spec))
  stdout(`wrote ${configPath}`)

  if (flags.workflow !== false) {
    const workflowPath = join(dir, WORKFLOW_PATH)
    if (existsSync(workflowPath) && !flags.force) {
      stderr(`note: ${WORKFLOW_PATH} already exists — left untouched (use --force to rewrite)`)
    } else {
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true })
      writeFileSync(workflowPath, workflowText({ setup: detection.setup, version }))
      stdout(`wrote ${WORKFLOW_PATH}`)
    }
  }

  stdout("")
  stdout("Next:")
  stdout("  export SPAWNDROID_API_KEY=…   # API & CI/CD → API keys, upload scope")
  stdout("  npx spawndroid check")
  stdout("  npx spawndroid run")
  return 0
}
