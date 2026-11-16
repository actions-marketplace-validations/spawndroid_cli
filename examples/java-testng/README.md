# Appium + TestNG on SpawnDroid

A minimal TestNG suite for an Android build on a hosted SpawnDroid runner.
Replace the package and add your own selectors after the smoke test passes.

## Run it

```bash
export SPAWNDROID_API_KEY=…
export SPAWNDROID_APP_PACKAGE=com.acme.checkout

npx spawndroid run path/to/app-debug.apk --profile android-14-phone -- mvn test
```

The CLI exports `SPAWNDROID_WD_URL`, `SPAWNDROID_UDID` and
`SPAWNDROID_APP_PACKAGE` into `mvn test`. The GitHub Action does the same:

```yaml
- run: npx spawndroid init --command "mvn test" --report target/surefire-reports/TEST-com.spawndroid.example.CheckoutTest.xml
- uses: spawndroid/cli@v0.1.2
  with:
    api-key: ${{ secrets.SPAWNDROID_API_KEY }}
```

## Files

- `pom.xml` — Java 17, Appium Java client, TestNG and Surefire.
- `src/test/java/com/spawndroid/example/CheckoutTest.java` — driver lifecycle
  and one app-state smoke test.

See the full guide: <https://docs.spawndroid.io/docs/guides/appium-java-testng>.
