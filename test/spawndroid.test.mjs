import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
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

test("reports unknown spec keys instead of guessing", () => {
  const dir = mkdtempSync(join(tmpdir(), "spawndroid-cli-"))
  const config = join(dir, "spawndroid.yaml")
  writeFileSync(config, "version: 1\napp: a\ncommand: run\ntimout: 300\n")
  const result = run(["check", "--config", config])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /unknown key "timout"/)
})
