import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { collectChecks } from "../src/check.mjs"

const okProbe = { probe: async () => ({ ok: true }), baseUrl: "https://example.invalid" }
const badProbe = {
  probe: async () => ({ ok: false, error: new Error("401") }),
  baseUrl: "https://example.invalid",
}

function spec(overrides = {}) {
  return {
    version: 1,
    app: "checkout",
    profile: null,
    command: [process.execPath, "--version"],
    fixtures: [],
    report: null,
    timeout: 600,
    ...overrides,
  }
}

test("a slug spec with a valid key passes", async () => {
  const { problems, warnings } = await collectChecks({
    spec: spec(),
    specDir: process.cwd(),
    api: okProbe,
  })
  assert.deepEqual(problems, [])
  assert.deepEqual(warnings, [])
})

test("a read-scoped key is a problem", async () => {
  const { problems } = await collectChecks({
    spec: spec(),
    specDir: process.cwd(),
    api: { probe: async () => ({ ok: true, scope: "read" }), baseUrl: "https://example.invalid" },
  })
  assert.match(problems.join("\n"), /needs the "upload" scope/)
})

test("the plan's session cap is surfaced as a warning", async () => {
  const { warnings } = await collectChecks({
    spec: spec(),
    specDir: process.cwd(),
    api: {
      probe: async () => ({ ok: true, scope: "upload", plan: "free", planLabel: "Hobby", maxSessionMinutes: 15 }),
      baseUrl: "https://example.invalid",
    },
  })
  assert.match(warnings.join("\n"), /stops a session after 15 minutes/)
})

test("a rejected key is a problem", async () => {
  const { problems } = await collectChecks({
    spec: spec(),
    specDir: process.cwd(),
    api: badProbe,
  })
  assert.match(problems.join("\n"), /API key was rejected/)
})

test("a missing APK path is a problem", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spawndroid-check-"))
  const { problems } = await collectChecks({
    spec: spec({ app: "build/app.apk" }),
    specDir: dir,
    api: okProbe,
  })
  assert.match(problems.join("\n"), /APK not found/)
})

test("a missing fixture is a problem", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spawndroid-check-"))
  const { problems } = await collectChecks({
    spec: spec({ fixtures: [{ local: "nope.jpg", device: "/sdcard/Pictures" }] }),
    specDir: dir,
    api: okProbe,
  })
  assert.match(problems.join("\n"), /fixture not found/)
})

test("a glob report is a problem", async () => {
  const { problems } = await collectChecks({
    spec: spec({ report: "reports/*.xml" }),
    specDir: process.cwd(),
    api: okProbe,
  })
  assert.match(problems.join("\n"), /single JUnit XML file/)
})

test("a short timeout and an unknown command are warnings", async () => {
  const { warnings } = await collectChecks({
    spec: spec({ command: ["definitely-not-a-binary-xyz"], timeout: 60 }),
    specDir: process.cwd(),
    api: okProbe,
  })
  assert.match(warnings.join("\n"), /boot \+ install ceiling/)
  assert.match(warnings.join("\n"), /not found on PATH/)
})
