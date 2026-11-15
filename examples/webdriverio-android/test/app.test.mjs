import assert from "node:assert/strict"

/**
 * A deliberately small suite: it proves the build runs on a real device
 * without knowing anything about the app.
 *
 * `driver` is provided by WebdriverIO. There is no `appium:app` capability —
 * the build is already installed on the session's device, so the suite owns the
 * app lifecycle and launches it itself.
 */

// The Action exports the package; through the hub you set it yourself. The hub
// also echoes it in the session capabilities, but not every client exposes
// non-standard capabilities on `driver`, so an environment variable is the
// dependable path.
const pkg =
  process.env.SPAWNDROID_APP_PACKAGE ??
  process.env.SPAWNDROID_PACKAGE ??
  driver.capabilities?.["spawndroid:appPackage"]

describe("the build on a real device", () => {
  it("launches and comes to the foreground", async () => {
    assert.ok(
      pkg,
      "no package under test — set SPAWNDROID_APP_PACKAGE to the app's Android package name"
    )
    await driver.activateApp(pkg)
    await driver.pause(2000)
    assert.equal(
      await driver.getCurrentPackage(),
      pkg,
      "the app did not come to the foreground"
    )
  })

  it("renders a UI tree", async () => {
    const source = await driver.getPageSource()
    assert.ok(
      source.includes(pkg),
      "the UI tree does not mention the app package — nothing rendered?"
    )
  })

  it("captures a screenshot", async () => {
    const screenshot = await driver.takeScreenshot()
    assert.ok(screenshot.length > 1000, "the screenshot looks empty")
  })
})
