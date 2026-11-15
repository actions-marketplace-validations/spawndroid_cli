# Examples

Runnable starters for running Appium suites on SpawnDroid. Each one reads the
session values from environment variables, so the same suite works locally,
through the GitHub Action, or through the CLI.

| Example                                      | Language   | Runner              |
| -------------------------------------------- | ---------- | ------------------- |
| [webdriverio-android](./webdriverio-android) | JavaScript | WebdriverIO + Mocha |
| [python-pytest](./python-pytest)             | Python     | pytest              |
| [java-testng](./java-testng)                 | Java       | TestNG + Maven      |

## Common setup

The session provides three values:

- `SPAWNDROID_WD_URL` — the session's W3C WebDriver endpoint.
- `SPAWNDROID_UDID` — the device serial.
- `SPAWNDROID_APP_PACKAGE` — the installed app package.

Start a session from the console or the API, then export them. The build is
already installed; none of the examples set `appium:app`.

## Tools

- [CLI](../README.md) — upload, start, wait, run and report from any terminal.
- [GitHub Action](../README.md#github-actions) — one step for a GitHub workflow.
- [Capabilities generator](https://spawndroid.io/tools/appium-capabilities/) — generate the capability block for Java, Kotlin, Python or WebdriverIO.
- [Guides](https://docs.spawndroid.io/docs/guides) — capabilities, CI, parallel runs, flaky tests and client variants.

The Hobby plan includes one runner and 200 device-minutes a month, no card.
