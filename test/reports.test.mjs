import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { collectReports, mergeJUnit } from "../src/reports.mjs"

const suite = (name, cases = 1) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${name}" tests="${cases}">${'<testcase name="t"/>'.repeat(cases)}</testsuite>`

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), "spawndroid-reports-"))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  return dir
}

/** Back-date a file so it predates the run. */
function old(dir, path) {
  const past = new Date(Date.now() - 3_600_000)
  utimesSync(join(dir, path), past, past)
}

const relative = (dir, found) => found.map((path) => path.slice(dir.length + 1)).sort()

test("an explicit file is used as is", async () => {
  const dir = project({ "out/junit.xml": suite("a") })
  assert.deepEqual(relative(dir, await collectReports({ dir, report: "out/junit.xml" })), ["out/junit.xml"])
})

test("a folder takes every XML file inside it", async () => {
  const dir = project({
    "results/TEST-a.xml": suite("a"),
    "results/nested/TEST-b.xml": suite("b"),
    "results/notes.txt": "not xml",
  })
  assert.deepEqual(relative(dir, await collectReports({ dir, report: "results" })), [
    "results/TEST-a.xml",
    "results/nested/TEST-b.xml",
  ])
})

test("a pattern matches with * and **", async () => {
  const dir = project({
    "app/build/test-results/testDebug/TEST-a.xml": suite("a"),
    "app/build/test-results/testDebug/other.xml": suite("x"),
    "lib/build/test-results/test/TEST-b.xml": suite("b"),
  })
  assert.deepEqual(relative(dir, await collectReports({ dir, report: "**/build/test-results/**/TEST-*.xml" })), [
    "app/build/test-results/testDebug/TEST-a.xml",
    "lib/build/test-results/test/TEST-b.xml",
  ])
})

test("with no report set, Gradle and Maven outputs written this run are found", async () => {
  const since = Date.now() - 1000
  const dir = project({
    "build/test-results/test/TEST-unit.xml": suite("unit"),
    "app/build/outputs/androidTest-results/connected/TEST-device.xml": suite("device"),
    "target/surefire-reports/TEST-maven.xml": suite("maven"),
    "build/test-results/test/TEST-stale.xml": suite("stale"),
    "node_modules/pkg/build/test-results/test/TEST-dep.xml": suite("dep"),
  })
  old(dir, "build/test-results/test/TEST-stale.xml")

  assert.deepEqual(relative(dir, await collectReports({ dir, report: null, since })), [
    "app/build/outputs/androidTest-results/connected/TEST-device.xml",
    "build/test-results/test/TEST-unit.xml",
    "target/surefire-reports/TEST-maven.xml",
  ])
})

test("nothing found is an empty list, not an error", async () => {
  const dir = project({ "README.md": "hi" })
  assert.deepEqual(await collectReports({ dir, report: null, since: 0 }), [])
  assert.deepEqual(await collectReports({ dir, report: "missing.xml" }), [])
})

test("several reports merge into one JUnit document", () => {
  const merged = mergeJUnit([suite("a", 2), suite("b", 3)])
  assert.match(merged, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<testsuites>/)
  assert.equal((merged.match(/<\?xml/g) ?? []).length, 1)
  assert.equal((merged.match(/<testcase\b/g) ?? []).length, 5)
  assert.match(merged, /<\/testsuites>\n?$/)
})

test("a single report is sent unchanged", () => {
  assert.equal(mergeJUnit([suite("a")]), suite("a"))
})
