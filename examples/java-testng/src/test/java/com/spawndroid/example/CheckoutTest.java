package com.spawndroid.example;

import io.appium.java_client.android.AndroidDriver;
import org.openqa.selenium.remote.DesiredCapabilities;
import org.testng.Assert;
import org.testng.annotations.AfterClass;
import org.testng.annotations.BeforeClass;
import org.testng.annotations.Test;

import java.net.URL;
import java.util.Map;

public class CheckoutTest {
  private AndroidDriver driver;
  private String appPackage;

  @BeforeClass
  public void setUp() throws Exception {
    appPackage = System.getenv("SPAWNDROID_APP_PACKAGE");

    DesiredCapabilities caps = new DesiredCapabilities();
    caps.setCapability("platformName", "Android");
    caps.setCapability("appium:automationName", "UiAutomator2");
    caps.setCapability("appium:udid", System.getenv("SPAWNDROID_UDID"));
    caps.setCapability("appium:appPackage", appPackage);
    caps.setCapability("appium:autoGrantPermissions", true);

    driver = new AndroidDriver(
        new URL(System.getenv("SPAWNDROID_WD_URL")), caps);
  }

  @Test
  public void appIsInTheForeground() {
    Object state = driver.executeScript(
        "mobile: queryAppState", Map.of("appId", appPackage));
    // 4 is Appium's "running in foreground" app state.
    Assert.assertEquals(state, 4);
  }

  @AfterClass(alwaysRun = true)
  public void tearDown() {
    if (driver != null) driver.quit();
  }
}
