import os


def test_app_is_in_the_foreground(driver):
    """App-agnostic smoke test; add your own selectors after this passes."""
    package = os.environ["SPAWNDROID_APP_PACKAGE"]
    # 4 is Appium's "running in foreground" app state.
    assert driver.query_app_state(package) == 4
