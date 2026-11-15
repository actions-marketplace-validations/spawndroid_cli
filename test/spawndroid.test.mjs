import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
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
  assert.match(result.stdout, /spawndroid run <app\.apk>/)
})

test("requires an API key before touching the network", () => {
  const result = run(["report", "sess_1", "--result", "passed"])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /SPAWNDROID_API_KEY is required/)
})

test("rejects an invalid report result", () => {
  const result = run(["report", "sess_1", "--result", "nope"], {
    SPAWNDROID_API_KEY: "test",
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--result passed\|failed/)
})
