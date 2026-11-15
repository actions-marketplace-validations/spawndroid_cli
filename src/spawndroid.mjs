#!/usr/bin/env node
/**
 * SpawnDroid CLI — upload, start, wait, run, report.
 *
 * No dependencies: Node 22 has fetch, FormData and Blob. The CLI is deliberately
 * small because the Action already covers GitHub Actions; this is for local
 * runs, GitLab, Jenkins and any other CI that can execute a command.
 */

import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { parseArgs } from "node:util"

const API_KEY = process.env.SPAWNDROID_API_KEY?.trim()
const API_URL = (
  process.env.SPAWNDROID_URL?.trim() || "https://app.spawndroid.io"
).replace(/\/$/, "")

const HELP = `spawndroid — hosted Android sessions for Appium and manual runs

Usage:
  spawndroid upload <app.apk> [--json]
  spawndroid start --app <slug> [--profile <id>] [--json]
  spawndroid wait <sessionId> [--timeout <seconds>]
  spawndroid report <sessionId> --result passed|failed
  spawndroid run <app.apk> [--profile <id>] [--timeout <seconds>] -- <command...>

Environment:
  SPAWNDROID_API_KEY   required; workspace API key with upload scope
  SPAWNDROID_URL       console origin (default https://app.spawndroid.io)

Examples:
  spawndroid run app-debug.apk -- npx wdio run wdio.conf.js
  spawndroid upload app-debug.apk
  spawndroid start --app checkout --profile android-14-phone
  spawndroid wait sess_123
  spawndroid report sess_123 --result passed
`

function fail(message) {
  console.error(`spawndroid: ${message}`)
  process.exit(1)
}

function requireKey() {
  if (!API_KEY) fail("SPAWNDROID_API_KEY is required")
}

async function api(path, init = {}) {
  requireKey()
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(init.headers ?? {}),
    },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const detail =
      body?.detail || body?.error || body?.title || response.statusText
    fail(`${response.status} ${detail}`)
  }
  return body
}

async function upload(apk) {
  const bytes = await readFile(apk)
  const form = new FormData()
  form.append("file", new Blob([bytes]), basename(apk))
  const body = await api("/api/apps", { method: "POST", body: form })
  return body?.app
}

async function start(app, profileId) {
  const body = await api("/api/v1/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      artifactId: app,
      ...(profileId ? { profileId } : {}),
    }),
  })
  return body
}

async function waitFor(sessionId, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000
  for (;;) {
    const body = await api(`/api/v1/sessions/${encodeURIComponent(sessionId)}`)
    if (body?.state === "ready") return { ...body, sessionId }
    if (body?.state === "failed") {
      fail(`session failed: ${body.error || body.errorCode || "unknown"}`)
    }
    if (Date.now() > deadline) {
      fail(`timed out after ${timeoutSeconds}s waiting for ${sessionId}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
}

async function report(sessionId, result) {
  await api(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ result }),
  })
}

function sessionEnv(view) {
  return {
    SPAWNDROID_WD_URL: view.webdriverUrl,
    SPAWNDROID_UDID: view.device?.serial,
    SPAWNDROID_APP_PACKAGE: view.app?.package,
    SPAWNDROID_APP: view.app?.slug,
    SPAWNDROID_SESSION_ID: view.sessionId,
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const separator = argv.indexOf("--")
  const head = separator >= 0 ? argv.slice(0, separator) : argv
  const commandArgs = separator >= 0 ? argv.slice(separator + 1) : []
  const [command, ...positionals] = head

  if (!command || command === "--help" || command === "-h") {
    console.log(HELP)
    return
  }

  if (command === "run") {
    const { values, positionals: runPositionals } = parseArgs({
      args: head.slice(1),
      allowPositionals: true,
      options: {
        profile: { type: "string" },
        timeout: { type: "string", default: "600" },
      },
    })
    const apk = runPositionals[0]
    if (!apk) fail("run requires an APK path")
    if (commandArgs.length === 0) fail("run requires a command after --")

    const app = await upload(apk)
    console.error(`uploaded ${app.slug} (v${app.version})`)
    const started = await start(app.slug, values.profile)
    const view = await waitFor(started.sessionId, Number(values.timeout))
    console.error(`ready: ${view.webdriverUrl}`)

    const child = spawn(commandArgs[0], commandArgs.slice(1), {
      stdio: "inherit",
      env: { ...process.env, ...sessionEnv(view) },
    })
    const code = await new Promise((resolve) => child.on("exit", resolve))
    await report(view.sessionId, code === 0 ? "passed" : "failed")
    process.exit(code ?? 1)
  }

  if (command === "upload") {
    const { values, positionals: uploadPositionals } = parseArgs({
      args: head.slice(1),
      allowPositionals: true,
      options: { json: { type: "boolean", default: false } },
    })
    const apk = uploadPositionals[0]
    if (!apk) fail("upload requires an APK path")
    const app = await upload(apk)
    console.log(values.json ? JSON.stringify(app, null, 2) : app.slug)
    return
  }

  if (command === "start") {
    const { values } = parseArgs({
      args: head.slice(1),
      allowPositionals: false,
      options: {
        app: { type: "string" },
        profile: { type: "string" },
        json: { type: "boolean", default: false },
      },
    })
    if (!values.app) fail("start requires --app <slug>")
    const view = await start(values.app, values.profile)
    console.log(values.json ? JSON.stringify(view, null, 2) : view.sessionId)
    return
  }

  if (command === "wait") {
    const { values, positionals: waitPositionals } = parseArgs({
      args: head.slice(1),
      allowPositionals: true,
      options: {
        timeout: { type: "string", default: "600" },
        json: { type: "boolean", default: false },
      },
    })
    const sessionId = waitPositionals[0]
    if (!sessionId) fail("wait requires a session id")
    const view = await waitFor(sessionId, Number(values.timeout))
    if (values.json) {
      console.log(JSON.stringify(view, null, 2))
    } else {
      for (const [key, value] of Object.entries(sessionEnv(view))) {
        console.log(`${key}=${value}`)
      }
    }
    return
  }

  if (command === "report") {
    const { values, positionals: reportPositionals } = parseArgs({
      args: head.slice(1),
      allowPositionals: true,
      options: { result: { type: "string" } },
    })
    const sessionId = reportPositionals[0]
    if (!sessionId) fail("report requires a session id")
    if (values.result !== "passed" && values.result !== "failed") {
      fail("report requires --result passed|failed")
    }
    await report(sessionId, values.result)
    console.log(`reported ${values.result} for ${sessionId}`)
    return
  }

  fail(`unknown command: ${command}\n\n${HELP}`)
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
