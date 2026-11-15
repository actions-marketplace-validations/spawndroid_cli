import os

import pytest
from appium import webdriver
from appium.options.android import UiAutomator2Options


@pytest.fixture
def driver():
    options = UiAutomator2Options().load_capabilities(
        {
            "platformName": "Android",
            "appium:automationName": "UiAutomator2",
            "appium:udid": os.environ["SPAWNDROID_UDID"],
            "appium:appPackage": os.environ["SPAWNDROID_APP_PACKAGE"],
            "appium:autoGrantPermissions": True,
        }
    )
    driver = webdriver.Remote(
        os.environ["SPAWNDROID_WD_URL"],
        options=options,
    )
    yield driver
    driver.quit()
