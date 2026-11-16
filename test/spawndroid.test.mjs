import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const CLI = new URL("../src/spawndroid.mjs", import.meta.url).pathname

function run(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, SPAWNDROID_API_KEY: "", ...env },
  })
}

test("prints usage", () => {
  const result = run(["--help"])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /spawndroid init/)
})

test("prints the version", () => {
  const result = run(["--version"])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /^spawndroid \d+\.\d+\.\d+/m)
})

test("requires an API key before touching the network", () => {
  const result = run(["report", "sess_1", "--result", "passed"])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /SPAWNDROID_API_KEY is not set/)
})

test("rejects an invalid report result", () => {
  const result = run(["report", "sess_1", "--result", "nope"], {
    SPAWNDROID_API_KEY: "test",
  })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /--result passed\|failed/)
})

test("wait prints only variables the readiness read actually has", async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(
      JSON.stringify({
        sessionId: "sess_1",
        state: "ready",
        webdriverUrl: "http://127.0.0.1:9/wd/hub",
        device: { serial: "emulator-5554" },
        // A CI session's readiness read does not carry a package.
        package: null,
      })
    )
  })
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  try {
    // spawn (not spawnSync): the fake server lives in this process, so a
    // blocking child would deadlock waiting for a response we cannot serve.
    const result = await new Promise((done) => {
      const child = spawn(process.execPath, [CLI, "wait", "sess_1", "--timeout", "5"], {
        env: {
          ...process.env,
          SPAWNDROID_API_KEY: "test",
          SPAWNDROID_URL: `http://127.0.0.1:${server.address().port}`,
        },
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (chunk) => (stdout += chunk))
      child.stderr.on("data", (chunk) => (stderr += chunk))
      child.on("exit", (status) => done({ status, stdout, stderr }))
    })
    assert.equal(result.status, 0)
    assert.doesNotMatch(result.stdout, /undefined/)
    assert.match(result.stdout, /SPAWNDROID_SESSION_ID=sess_1/)
  } finally {
    await new Promise((done) => server.close(done))
  }
})

test("reports unknown spec keys instead of guessing", () => {
  const dir = mkdtempSync(join(tmpdir(), "spawndroid-cli-"))
  const config = join(dir, "spawndroid.yaml")
  writeFileSync(config, "version: 1\napp: a\ncommand: run\ntimout: 300\n")
  const result = run(["check", "--config", config])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /unknown key "timout"/)
})
