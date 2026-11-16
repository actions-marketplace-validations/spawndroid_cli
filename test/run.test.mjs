import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { createApi } from "../src/api.mjs"
import { executeRun } from "../src/run.mjs"

/**
 * A fake console: enough of the v1 shape that executeRun's real HTTP client
 * talks to it unmodified.
 */
async function startConsole({
  createFailures = 0,
  createCode = "free_pool_full",
  createStatus = 429,
  readyFailures = 0,
  readyPackage = "com.example",
} = {}) {
  const state = {
    creates: [],
    ends: [],
    reports: [],
    presigns: [],
    puts: [],
    commits: [],
    gets: 0,
    readyAfter: 1,
    createFailures,
    createCode,
    createStatus,
    readyFailures,
    readyPackage,
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost")
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    const json = () => {
      try {
        return JSON.parse(raw.toString("utf8"))
      } catch {
        return null
      }
    }
    const send = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json" })
      response.end(JSON.stringify(body))
    }

    if (request.method === "POST" && url.pathname === "/api/v1/sessions") {
      state.creates.push({
        body: json(),
        key: request.headers["idempotency-key"],
      })
      if (state.creates.length <= state.createFailures) {
        return send(state.createStatus, { code: state.createCode, detail: "not now" })
      }
      return send(201, {
        sessionId: "sess_1",
        state: "creating",
        webdriverUrl: "http://127.0.0.1:9/wd/hub",
        device: { serial: "emulator-5554" },
        app: { package: "com.example" },
      })
    }
    if (request.method === "GET" && url.pathname === "/api/v1/sessions/sess_1") {
      state.gets += 1
      if (state.gets <= state.readyFailures) {
        return send(504, { code: "UPSTREAM_TIMEOUT", detail: "The device host timed out." })
      }
      if (state.gets >= state.readyAfter) {
        return send(200, {
          sessionId: "sess_1",
          state: "ready",
          webdriverUrl: "http://127.0.0.1:9/wd/hub",
          device: { serial: "emulator-5554" },
          package: state.readyPackage,
        })
      }
      return send(200, { sessionId: "sess_1", state: "booting" })
    }
    if (request.method === "DELETE" && url.pathname === "/api/v1/sessions/sess_1") {
      state.ends.push(json())
      return send(200, { ok: true })
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/sessions/sess_1/files/presign"
    ) {
      state.presigns.push(json())
      return send(200, {
        key: "tenant/session/fixture.bin",
        url: `${state.root}/upload/fixture.bin`,
        contentType: "application/octet-stream",
      })
    }
    if (request.method === "PUT" && url.pathname === "/upload/fixture.bin") {
      state.puts.push(raw.length)
      return send(200, {})
    }
    if (request.method === "POST" && url.pathname === "/api/v1/sessions/sess_1/files") {
      state.commits.push(json())
      return send(200, { ok: true })
    }
    if (request.method === "POST" && url.pathname === "/api/v1/sessions/sess_1/report") {
      state.reports.push(raw.toString("utf8"))
      return send(201, { ok: true, report: {} })
    }
    return send(404, { code: "NOT_FOUND" })
  })

  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  state.root = `http://127.0.0.1:${server.address().port}`
  state.close = () => new Promise((done) => server.close(done))
  return state
}

function baseSpec(overrides = {}) {
  return {
    version: 1,
    app: "checkout",
    profile: null,
    command: [process.execPath, "-e", "process.exit(0)"],
    fixtures: [],
    report: null,
    timeout: 5,
    ...overrides,
  }
}

const quiet = () => {}
const fast = { pollMs: 5, retryDelayMs: 5 }

test("the readiness view's package reaches the command's environment", async () => {
  const consoleState = await startConsole()
  const dir = mkdtempSync(join(tmpdir(), "spawndroid-env-"))
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test" })
    const outcome = await executeRun({
      spec: baseSpec({
        command: [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync('env.txt', process.env.SPAWNDROID_APP_PACKAGE ?? '')",
        ],
      }),
      specDir: dir,
      api,
      log: quiet,
      ...fast,
    })
    assert.equal(outcome.exitCode, 0)
    assert.equal(readFileSync(join(dir, "env.txt"), "utf8"), "com.example")
  } finally {
    await consoleState.close()
  }
})

test("falls back to the create response when readiness omits the package", async () => {
  const consoleState = await startConsole({ readyPackage: null })
  const dir = mkdtempSync(join(tmpdir(), "spawndroid-env-"))
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test" })
    const outcome = await executeRun({
      spec: baseSpec({
        command: [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync('env.txt', process.env.SPAWNDROID_APP_PACKAGE ?? '')",
        ],
      }),
      specDir: dir,
      api,
      log: quiet,
      ...fast,
    })
    assert.equal(outcome.exitCode, 0)
    assert.equal(readFileSync(join(dir, "env.txt"), "utf8"), "com.example")
  } finally {
    await consoleState.close()
  }
})

test("green command: passes the run, tears down and attaches JUnit", async () => {
  const consoleState = await startConsole()
  const dir = mkdtempSync(join(tmpdir(), "spawndroid-run-"))
  writeFileSync(join(dir, "junit.xml"), "<testsuite/>")
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test" })
    const outcome = await executeRun({
      spec: baseSpec({ report: "junit.xml" }),
      specDir: dir,
      api,
      log: quiet,
      ...fast,
    })
    assert.equal(outcome.exitCode, 0)
    assert.equal(outcome.result, "passed")
    assert.deepEqual(consoleState.ends, [{ result: "passed" }])
    assert.equal(consoleState.reports.length, 1)
    assert.deepEqual(consoleState.creates[0].body, { artifactId: "checkout" })
    assert.match(consoleState.creates[0].key, /^spawndroid-/)
  } finally {
    await consoleState.close()
  }
})

test("failing command: exit 1 and a failed verdict", async () => {
  const consoleState = await startConsole()
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test" })
    const outcome = await executeRun({
      spec: baseSpec({ command: [process.execPath, "-e", "process.exit(3)"] }),
      specDir: process.cwd(),
      api,
      log: quiet,
      ...fast,
    })
    assert.equal(outcome.exitCode, 1)
    assert.deepEqual(consoleState.ends, [{ result: "failed" }])
  } finally {
    await consoleState.close()
  }
})

test("a transient start failure is retried with the same key", async () => {
  const consoleState = await startConsole({
    createFailures: 1,
    createStatus: 504,
    createCode: "UPSTREAM_TIMEOUT",
  })
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test" })
    const outcome = await executeRun({
      spec: baseSpec(),
      specDir: process.cwd(),
      api,
      log: quiet,
      ...fast,
    })
    assert.equal(outcome.exitCode, 0)
    assert.equal(consoleState.creates.length, 2)
    assert.equal(consoleState.creates[0].key, consoleState.creates[1].key)
  } finally {
    await consoleState.close()
  }
})

test("a transient readiness failure is retried until the deadline", async () => {
  const consoleState = await startConsole({ readyFailures: 2 })
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test" })
    const outcome = await executeRun({
      spec: baseSpec(),
      specDir: process.cwd(),
      api,
      log: quiet,
      ...fast,
    })
    assert.equal(outcome.exitCode, 0)
    assert.equal(outcome.result, "passed")
  } finally {
    await consoleState.close()
  }
})

test("plan limits are not retried", async () => {
  const consoleState = await startConsole({ createFailures: 1, createCode: "PLAN_RUNNER_LIMIT" })
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test" })
    const outcome = await executeRun({
      spec: baseSpec(),
      specDir: process.cwd(),
      api,
      log: quiet,
      ...fast,
    })
    assert.equal(outcome.exitCode, 2)
    assert.equal(consoleState.creates.length, 1)
  } finally {
    await consoleState.close()
  }
})

test("capacity 429 is retried with the same idempotency key", async () => {
  const consoleState = await startConsole({ createFailures: 1 })
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test" })
    const outcome = await executeRun({
      spec: baseSpec(),
      specDir: process.cwd(),
      api,
      log: quiet,
      ...fast,
    })
    assert.equal(outcome.exitCode, 0)
    assert.equal(consoleState.creates.length, 2)
    assert.equal(consoleState.creates[0].key, consoleState.creates[1].key)
  } finally {
    await consoleState.close()
  }
})

test("fixtures are presigned, uploaded and committed", async () => {
  const consoleState = await startConsole()
  const dir = mkdtempSync(join(tmpdir(), "spawndroid-fixtures-"))
  writeFileSync(join(dir, "fixture.bin"), Buffer.from("hello"))
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test" })
    const outcome = await executeRun({
      spec: baseSpec({
        fixtures: [{ local: "fixture.bin", device: "/sdcard/Download" }],
      }),
      specDir: dir,
      api,
      log: quiet,
      ...fast,
    })
    assert.equal(outcome.exitCode, 0)
    assert.deepEqual(consoleState.presigns, [
      { filename: "fixture.bin", path: "/sdcard/Download", size: 5 },
    ])
    assert.deepEqual(consoleState.puts, [5])
    assert.deepEqual(consoleState.commits, [
      { key: "tenant/session/fixture.bin", path: "/sdcard/Download", filename: "fixture.bin" },
    ])
  } finally {
    await consoleState.close()
  }
})

test("a device that never becomes ready is an infrastructure failure", async () => {
  const consoleState = await startConsole()
  consoleState.readyAfter = 1_000
  try {
    const api = createApi({ baseUrl: consoleState.root, apiKey: "test" })
    const outcome = await executeRun({
      spec: baseSpec({ timeout: 0 }),
      specDir: process.cwd(),
      api,
      log: quiet,
      ...fast,
    })
    assert.equal(outcome.exitCode, 2)
    assert.deepEqual(consoleState.ends, [{ result: "failed" }])
  } finally {
    await consoleState.close()
  }
})
