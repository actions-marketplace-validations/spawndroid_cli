import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  SpecError,
  detectProject,
  parseSpec,
  specText,
} from "../src/config.mjs"

function dir() {
  return mkdtempSync(join(tmpdir(), "spawndroid-config-"))
}

test("parses a minimal spec", () => {
  const spec = parseSpec(`version: 1
app: build/app.apk
command: mvn test
`)
  assert.equal(spec.app, "build/app.apk")
  assert.deepEqual(spec.command, ["mvn", "test"])
  assert.deepEqual(spec.fixtures, [])
  assert.equal(spec.report, null)
  assert.equal(spec.timeout, 600)
})

test("a list command is exact argv", () => {
  const spec = parseSpec(`version: 1
app: app
command: [bash, -c, "mvn test && cp report.xml ."]
`)
  assert.deepEqual(spec.command, ["bash", "-c", "mvn test && cp report.xml ."])
})

test("fixtures accept a shorthand and an explicit device directory", () => {
  const spec = parseSpec(`version: 1
app: app
command: run
fixtures:
  - test/fixtures/a.jpg
  - local: test/fixtures/b.json
    device: /sdcard/Pictures
`)
  assert.deepEqual(spec.fixtures, [
    { local: "test/fixtures/a.jpg", device: "/sdcard/Download" },
    { local: "test/fixtures/b.json", device: "/sdcard/Pictures" },
  ])
})

test("unknown keys are errors, not warnings", () => {
  assert.throws(
    () =>
      parseSpec(`version: 1
app: a
command: run
timout: 300
`),
    (error) => error instanceof SpecError && /unknown key "timout"/.test(error.message)
  )
})

test("version must be 1", () => {
  assert.throws(
    () => parseSpec(`version: 2\napp: a\ncommand: run\n`),
    (error) => error instanceof SpecError && /"version" must be 1/.test(error.message)
  )
})

test("a fixture device directory must stay under /sdcard", () => {
  assert.throws(
    () =>
      parseSpec(`version: 1
app: a
command: run
fixtures:
  - local: x
    device: /data/local/tmp
`),
    (error) => error instanceof SpecError && /absolute directory under \/sdcard/.test(error.message)
  )
})

test("missing app is reported", () => {
  assert.throws(
    () => parseSpec(`version: 1\ncommand: run\n`),
    (error) => error instanceof SpecError && /"app" is required/.test(error.message)
  )
})

test("specText round-trips", () => {
  const source = parseSpec(`version: 1
app: build/app.apk
profile: android-14-phone
command: [mvn, test]
report: target/junit.xml
timeout: 900
fixtures:
  - local: a.png
    device: /sdcard/Pictures
`)
  const again = parseSpec(specText(source))
  assert.deepEqual(again, source)
})

test("detects a Maven project", () => {
  const root = dir()
  writeFileSync(join(root, "pom.xml"), "<project/>")
  const detected = detectProject(root)
  assert.equal(detected.stack, "maven")
  assert.deepEqual(detected.command, ["mvn", "test"])
})

test("detects a WebdriverIO project and its config", () => {
  const root = dir()
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ devDependencies: { webdriverio: "^9" } })
  )
  writeFileSync(join(root, "wdio.conf.mjs"), "export const config = {}")
  const detected = detectProject(root)
  assert.equal(detected.stack, "node")
  assert.deepEqual(detected.command, ["npx", "wdio", "run", "wdio.conf.mjs"])
})

test("detects a built APK in a Gradle module", () => {
  const root = dir()
  const debug = join(root, "app", "build", "outputs", "apk", "debug")
  mkdirSync(debug, { recursive: true })
  writeFileSync(join(debug, "app-debug.apk"), "apk")
  writeFileSync(join(root, "settings.gradle.kts"), 'include(":app")')
  writeFileSync(join(root, "app", "build.gradle.kts"), 'plugins { id("com.android.application") }')
  const detected = detectProject(root)
  assert.equal(detected.app, join("app", "build", "outputs", "apk", "debug", "app-debug.apk"))
})
