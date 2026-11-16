# Appium + pytest on SpawnDroid

A minimal Android UI test that runs on a hosted SpawnDroid runner. The test is
app-agnostic; point `SPAWNDROID_APP_PACKAGE` at your build and replace the
selectors.

## Run it

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export SPAWNDROID_API_KEY=…
export SPAWNDROID_APP_PACKAGE=com.acme.checkout

# The CLI uploads, starts, waits, exports the session values and reports.
npx spawndroid run path/to/app-debug.apk --profile android-14-phone -- pytest -q
```

Or use the GitHub Action:

```yaml
- run: npx spawndroid init --command "pytest -q --junitxml=reports/junit.xml" --report reports/junit.xml
- uses: spawndroid/cli@v0.1.2
  with:
    api-key: ${{ secrets.SPAWNDROID_API_KEY }}
```

The fixture expects `SPAWNDROID_WD_URL`, `SPAWNDROID_UDID` and
`SPAWNDROID_APP_PACKAGE`. The action and CLI both provide them.

## Files

- `test/conftest.py` — driver fixture and capabilities.
- `test/test_app.py` — one smoke test; replace the selectors with your app's.

See the full guide: <https://docs.spawndroid.io/docs/guides/appium-python-pytest>.
