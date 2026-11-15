/**
 * One WebdriverIO config, two ways into SpawnDroid.
 *
 *  - **Stable hub** (recommended): one URL and one token, the build chosen by
 *    capability. Nothing changes between runs.
 *      SPAWNDROID_HUB_URL=https://stream.spawndroid.io/wd/hub
 *      SPAWNDROID_CI_TOKEN=…        (API & CI/CD → WebDriver hub, or the
 *                                    artifact's Automation page)
 *      SPAWNDROID_APP=my-app        (the stored build to test)
 *
 *  - **A session the GitHub Action already started**: it exports the endpoint
 *    and the device details, so no other configuration is needed.
 *      SPAWNDROID_WD_URL, SPAWNDROID_UDID, SPAWNDROID_APP_PACKAGE
 *
 * The suite itself never changes between the two — which is the point.
 */

const hubUrl = process.env.SPAWNDROID_HUB_URL
const ciToken = process.env.SPAWNDROID_CI_TOKEN
const sessionUrl = process.env.SPAWNDROID_WD_URL

/**
 * The app under test, as its Android package name. Required in both modes:
 * the Action exports it, and through the hub you set it yourself. The hub
 * accepts a package wherever it accepts a slug, so one variable does for both
 * the capability and the assertions.
 */
const appPackage =
  process.env.SPAWNDROID_APP_PACKAGE ?? process.env.SPAWNDROID_PACKAGE

/** Split an endpoint into the pieces WebdriverIO asks for. */
function endpoint(url) {
  const parsed = new URL(url)
  return {
    protocol: parsed.protocol.replace(":", ""),
    hostname: parsed.hostname,
    port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
    path: parsed.pathname,
  }
}

/** Only set the capabilities we actually have, so Appium sees no nulls. */
function withValues(capabilities) {
  return Object.fromEntries(
    Object.entries(capabilities).filter(([, value]) => value !== undefined)
  )
}

let connection
let capabilities

if (hubUrl && ciToken) {
  connection = {
    ...endpoint(hubUrl),
    // Device clouds hand credentials to clients as a user/key pair; the hub
    // accepts them as HTTP Basic (the token may sit in either field).
    user: "spawndroid",
    key: ciToken,
  }
  capabilities = withValues({
    platformName: "Android",
    "appium:automationName": "UiAutomator2",
    // The build and the device are capabilities here, not configuration.
    // A package name is accepted where a slug is, so `SPAWNDROID_APP` is only
    // needed when you would rather name the artifact than the package.
    "spawndroid:app": process.env.SPAWNDROID_APP ?? appPackage,
    "spawndroid:profile": process.env.SPAWNDROID_PROFILE,
    // Optional: ties the run to the revision in the console's Runs list.
    "spawndroid:commit": process.env.SPAWNDROID_COMMIT,
    "spawndroid:branch": process.env.SPAWNDROID_BRANCH,
    "spawndroid:repo": process.env.SPAWNDROID_REPO_URL,
  })
} else if (sessionUrl) {
  // The endpoint is already scoped to one device and carries its own token.
  connection = endpoint(sessionUrl)
  capabilities = withValues({
    platformName: "Android",
    "appium:automationName": "UiAutomator2",
    "appium:udid": process.env.SPAWNDROID_UDID,
    // The build is pre-installed: never set `appium:app`.
    "appium:appPackage": process.env.SPAWNDROID_APP_PACKAGE,
    "appium:noReset": true,
  })
} else {
  throw new Error(
    "No SpawnDroid endpoint. Set SPAWNDROID_HUB_URL + SPAWNDROID_CI_TOKEN, " +
      "or run inside the GitHub Action, which exports SPAWNDROID_WD_URL."
  )
}

export const config = {
  runner: "local",
  specs: ["./test/**/*.test.mjs"],
  maxInstances: 1,
  capabilities: [capabilities],

  logLevel: "warn",
  framework: "mocha",
  // Writes ./reports/junit.xml — hand this to the Action as `report-path` and
  // the failing tests show up on the run page.
  reporters: [
    ["junit", { outputDir: "./reports", outputFileFormat: () => "junit.xml" }],
  ],
  mochaOpts: {
    ui: "bdd",
    // Device boot and install happen before the first command on a cold
    // session, so give the first assertion room.
    timeout: 3 * 60 * 1000,
  },

  ...connection,
  connectionRetryTimeout: 5 * 60 * 1000,
  connectionRetryCount: 2,
}
