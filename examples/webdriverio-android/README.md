# WebdriverIO on SpawnDroid

A copyable starter that drives a real Android device in the cloud with
[WebdriverIO](https://webdriver.io). Copy this directory into your repo, point
it at a build, and you have a browser-free UI test loop on arm64 Android.

The same suite works two ways, which is the point: locally against the **stable
hub**, and in CI under the [SpawnDroid Action](../../README.md#github-actions) —
with no change to the tests themselves.

## Quick start — the stable hub

```bash
export SPAWNDROID_HUB_URL=https://stream.spawndroid.io/wd/hub
export SPAWNDROID_CI_TOKEN=…                  # API & CI/CD → CI/CD → WebDriver hub token
export SPAWNDROID_APP_PACKAGE=com.example.app # the package to test
pnpm install
pnpm test                                     # → reports/junit.xml
```

`SPAWNDROID_APP_PACKAGE` is the only "which app" you need: the hub accepts a
package name wherever it accepts a slug, so the same value selects the build and
tells the suite what to launch. (`SPAWNDROID_APP` overrides the selection if you
would rather name the artifact.)

Nothing has to be started first: the first WebDriver command allocates a
device, installs that build, and records the run. The build and the device are
**capabilities**, not configuration — so this is the whole setup, once.

## Quick start — in CI

```yaml
- uses: actions/checkout@v4
- uses: pnpm/action-setup@v4
- uses: actions/setup-node@v4
  with: { node-version: 22, cache: pnpm }
- run: pnpm install --frozen-lockfile

- name: Write the spec
  run: npx spawndroid init --command "pnpm --filter @spawndroid/example-webdriverio test" --report reports/junit.xml --profile android-14-phone

- name: Run UI tests on a real device
  uses: spawndroid/cli@v0.1.3
  with:
    api-key: ${{ secrets.SPAWNDROID_API_KEY }}
```

The Action uploads the build, boots a device, waits for it, runs the command
with the endpoint already in the environment, reports pass/fail, and attaches
the JUnit report to the run — so a failure is a test name, not a log hunt.

## What the suite asserts

Deliberately app-agnostic, so it works before you write a real test:

1. the app launches and comes to the foreground;
2. it renders a UI tree mentioning its package;
3. it screenshots.

Add your own specs next to `test/`. There is **no `appium:app` capability** —
the build is already installed on the session's device, so the suite owns the
app lifecycle and launches it itself.

## Environment

| Variable                                                          | Used by     | Notes                                                                                            |
| ----------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| `SPAWNDROID_APP_PACKAGE`                                          | both        | **Required.** The Android package under test — selects the build and is what the suite launches. |
| `SPAWNDROID_HUB_URL`                                              | hub mode    | e.g. `https://stream.spawndroid.io/wd/hub`                                                       |
| `SPAWNDROID_CI_TOKEN`                                             | hub mode    | sent as HTTP Basic (`spawndroid` / token)                                                        |
| `SPAWNDROID_APP`                                                  | hub mode    | optional; a slug or id, overriding the package as the build selector                             |
| `SPAWNDROID_PROFILE`                                              | hub mode    | optional, e.g. `android-14-phone`                                                                |
| `SPAWNDROID_COMMIT` / `SPAWNDROID_BRANCH` / `SPAWNDROID_REPO_URL` | hub mode    | optional; ties the run to a revision                                                             |
| `SPAWNDROID_WD_URL`                                               | CLI/Action  | the per-run endpoint the CLI exports                                                             |
| `SPAWNDROID_UDID`                                                 | CLI/Action  | device serial → `appium:udid`                                                                    |

See [docs/ci-tests](https://docs.spawndroid.io/docs/ci-tests) for the full
picture.

Through the hub, the package under test comes back on
`driver.capabilities["spawndroid:appPackage"]`, so the suite does not need to be
told it.
