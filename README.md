# spawndroid

Run Android tests on hosted devices from any CI.

Upload an APK, boot a real device, run your test command against it, and keep
the result along with the logcat and screen recording.

## Quick start

```bash
export SPAWNDROID_API_KEY=spawn_live_…   # workspace key with `upload` scope

npx spawndroid run app/build/outputs/apk/debug/app-debug.apk -- \
  npx wdio run wdio.conf.js
```

`run` uploads the build, starts a session, waits for the device, executes the
command with the session exported into its environment, then reports the result
and tears the device down.

| Variable                | Meaning                          |
| ----------------------- | -------------------------------- |
| `SPAWNDROID_WD_URL`     | W3C WebDriver endpoint           |
| `SPAWNDROID_UDID`       | device serial                    |
| `SPAWNDROID_APP_PACKAGE`| installed app package            |
| `SPAWNDROID_APP`        | app slug                         |
| `SPAWNDROID_SESSION_ID` | session id                       |

The build is installed before your command runs — never set `appium:app`.

## GitHub Actions

```yaml
- uses: spawndroid/cli@v0.1.0
  with:
    api-key: ${{ secrets.SPAWNDROID_API_KEY }}
    command: mvn test
    app-path: app/build/outputs/apk/debug/app-debug.apk
    report-path: target/surefire-reports/TEST-com.example.CheckoutTest.xml
```

The Action also works on runners without Node. Outputs: `session-id`,
`run-url`, `result`, `app-slug`.

## Commands

```bash
npx spawndroid run <app.apk> [--profile <id>] [--timeout <seconds>] -- <command…>
npx spawndroid upload <app.apk> [--json]
npx spawndroid start --app <slug> [--profile <id>] [--json]
npx spawndroid wait <sessionId> [--timeout <seconds>] [--json]
npx spawndroid report <sessionId> --result passed|failed
```

## Examples

| Example                                       | Language   | Runner              |
| --------------------------------------------- | ---------- | ------------------- |
| [webdriverio-android](./examples/webdriverio-android) | JavaScript | WebdriverIO + Mocha |
| [python-pytest](./examples/python-pytest)     | Python     | pytest              |
| [java-testng](./examples/java-testng)         | Java       | TestNG + Maven      |

## Docs

Capabilities generator, guides and the API reference live at
[docs.spawndroid.io](https://docs.spawndroid.io). Plans and limits are at
[spawndroid.io/pricing](https://spawndroid.io/pricing).

MIT licensed.
