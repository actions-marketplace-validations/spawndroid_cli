/**
 * `spawndroid check` — name every wall before the first run instead of
 * returning a 403 halfway through CI.
 */

import { accessSync, constants, statSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"

import { DEVICE_FILE_MAX_BYTES } from "./config.mjs"

const HOST_BOOT_AND_INSTALL_SECONDS = 420

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isExecutableOnPath(command) {
  if (command.includes("/")) {
    try {
      accessSync(command, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  const probe = process.platform === "win32" ? "where" : "which"
  return spawnSync(probe, [command], { stdio: "ignore", encoding: "utf8" }).status === 0
}

export async function collectChecks({ spec, specDir, api }) {
  const problems = []
  const warnings = []

  let probe = null
  try {
    probe = await api.probe()
    if (!probe.ok) {
      problems.push(
        "the API key was rejected (401/403) — create a key with the upload scope in API & CI/CD → API keys"
      )
    } else if (probe.scope === "read") {
      problems.push(
        'the API key is scoped to "read"; running tests needs the "upload" scope'
      )
    }
  } catch (error) {
    problems.push(`could not reach ${api.baseUrl}: ${error.message}`)
  }

  if (probe?.maxSessionMinutes) {
    warnings.push(
      `your plan (${probe.planLabel ?? probe.plan}) stops a session after ${probe.maxSessionMinutes} minutes of device time`
    )
  }
  if (probe?.slots === 0) {
    warnings.push("your plan allows no parallel runners; a start will be refused")
  }

  const appPath = resolve(specDir, spec.app)
  const looksLikePath = /\.apk$/i.test(spec.app) || spec.app.includes("/")
  if (isFile(appPath)) {
    if (!/\.apk$/i.test(appPath)) warnings.push(`${spec.app} does not end in .apk — only APKs install`)
  } else if (looksLikePath) {
    problems.push(`APK not found: ${appPath} — build the app before running tests`)
  }

  for (const fixture of spec.fixtures) {
    const local = resolve(specDir, fixture.local)
    if (!isFile(local)) {
      problems.push(`fixture not found: ${fixture.local}`)
      continue
    }
    const size = statSync(local).size
    if (size > DEVICE_FILE_MAX_BYTES) {
      problems.push(`fixture ${fixture.local} is larger than the 32 MB limit`)
    }
  }

  if (spec.report && spec.report.includes("*")) {
    problems.push(`"report" must be a single JUnit XML file, not a glob (${spec.report})`)
  }

  if (spec.timeout < HOST_BOOT_AND_INSTALL_SECONDS) {
    warnings.push(
      `timeout ${spec.timeout}s is below the host's ~${HOST_BOOT_AND_INSTALL_SECONDS}s boot + install ceiling`
    )
  }

  if (!isExecutableOnPath(spec.command[0])) {
    warnings.push(`test command "${spec.command[0]}" was not found on PATH`)
  }

  return { problems, warnings }
}

export function planNotes() {
  return [
    "limits: sessions stop at your plan's cap (Hobby: 15 minutes of device time);",
    "        Hobby builds expire 7 days after upload; Hobby logcat is live-only.",
    "        Logcat, video and JUnit history are kept for your plan's retention window.",
  ]
}
