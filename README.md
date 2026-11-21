# spawndroid

Run Android tests on hosted devices from any CI.

Upload a build, boot a real device, run your test command against it, and keep
the result along with the JUnit report, logcat and screen recording.

## Install

Node 20 or newer. Nothing to install for a one-off run:

```bash
npx spawndroid run
```

Or install it — globally, or as a dev dependency pinned with the project:

```bash
npm install --global spawndroid
npm install --save-dev spawndroid
```

## Quick start

```bash
npx spawndroid init                                  # detect the project, write the spec + workflow
export SPAWNDROID_API_KEY=spawn_live_…               # API & CI/CD → API keys, upload scope
npx spawndroid check                                 # name the walls before the first run
npx spawndroid run                                   # upload → boot → test → report → teardown
```

`init` reads the project (Gradle, Maven, WebdriverIO, pytest), prints what it
inferred, and writes `spawndroid.yaml` plus
`.github/workflows/spawndroid.yml`. It asks only for what it cannot infer.
Every flag is overridable for non-interactive setups:

```bash
npx spawndroid init --app app/build/outputs/apk/debug/app-debug.apk \
  --command "mvn test" --report target/surefire-reports/TEST-com.example.CheckoutTest.xml
```

## The spec

```yaml
version: 1
app: app/build/outputs/apk/debug/app-debug.apk   # APK path, or an uploaded app slug
command: [mvn, test]                             # string is split; list is exact argv
profile: android-14-phone                        # optional device profile
report: target/surefire-reports                  # optional: file, folder or pattern
timeout: 600                                     # seconds to wait for the device
fixtures:                                        # optional files pushed after readiness
  - local: test/fixtures/sample.jpg
    device: /sdcard/Pictures                     # absolute directory under /sdcard
```

Unknown keys are errors — a misspelled `timeout` must not silently fall back
to the default.

`report` is optional. It can be one JUnit XML file, a folder (every `.xml`
inside it), or a pattern such as `app/build/test-results/**/TEST-*.xml`.
Without it, `run` looks where the build tools write reports —
`build/test-results/`, `build/outputs/androidTest-results/` (Gradle, any
module) and `target/surefire-reports/` (Maven) — and attaches only the files
your command wrote during this run. Several files are merged into one report.

## Commands

```bash
spawndroid init     [--app <apk>] [--command <cmd>] [--report <xml>] [--profile <id>] [--force]
spawndroid check    [--config <path>]
spawndroid run      [--config <path>] [--profile <id>] [--timeout <s>] [-- <command…>]
spawndroid upload   <app.apk> [--json]
spawndroid start    --app <slug> [--profile <id>] [--json]
spawndroid wait     <sessionId> [--timeout <s>] [--json]
spawndroid report   <sessionId> --result passed|failed
```

## What `run` does

1. Uploads the APK (or reuses the slug), creating a session with an
   `Idempotency-Key`.
2. Retries a *capacity* `429` up to 3 attempts over ~90 s; plan limits
   (`PLAN_RUNNER_LIMIT`, `PLAN_DEVICE_MINUTES_EXHAUSTED`) fail immediately.
3. Waits up to `timeout` for the device, then pushes fixtures.
4. Runs `command` locally on the runner with the session in its environment.
5. Attaches the JUnit report (found automatically unless `report` names it),
   tears the device down, and prints the run URL.

Exported to the command:

| Variable                 | Meaning                   |
| ------------------------ | ------------------------- |
| `SPAWNDROID_WD_URL`      | W3C WebDriver endpoint    |
| `SPAWNDROID_UDID`        | device serial             |
| `SPAWNDROID_APP_PACKAGE` | installed app package     |
| `SPAWNDROID_APP`         | app slug                  |
| `SPAWNDROID_SESSION_ID`  | session id                |

The build is installed before your command runs — never set `appium:app`.

Exit codes: `0` tests passed, `1` tests failed, `2` infrastructure or setup
failed. CI retry logic can key off that instead of re-running real failures.

## GitHub Actions

```yaml
- uses: spawndroid/cli@v0.1.7
  with:
    api-key: ${{ secrets.SPAWNDROID_API_KEY }}
```

The Action installs the CLI, runs `spawndroid run --config spawndroid.yaml`,
and exposes `session-id`, `run-url` and `result` as step outputs.

## Limits

- Appium / WebDriver suites only: sessions expose a WebDriver endpoint, not adb.
- One APK per session; the APK is installed before the command starts.
- Per-run sessions. The stable hub is documented separately at
  [docs.spawndroid.io](https://docs.spawndroid.io/docs/ci-tests).
- Hobby: 15-minute sessions, 7-day build expiry, live logcat only.

## Examples

| Example                                               | Language   | Runner              |
| ----------------------------------------------------- | ---------- | ------------------- |
| [webdriverio-android](./examples/webdriverio-android) | JavaScript | WebdriverIO + Mocha |
| [python-pytest](./examples/python-pytest)             | Python     | pytest              |
| [java-testng](./examples/java-testng)                 | Java       | TestNG + Maven      |

MIT licensed.
