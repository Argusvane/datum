package com.argusvane.datum.webauthn.web;

import java.util.regex.Pattern;

/**
 * "Chrome on macOS" from a User-Agent, the label the passkey list shows (endpoint catalog {@code listPasskeys}).
 * Only this summary is kept with a passkey, never the User-Agent itself.
 */
public final class PasskeyBrowser {

    private static final Pattern EDGE = Pattern.compile("\\bEdg(e|A|iOS)?/");
    private static final Pattern OPERA = Pattern.compile("\\b(OPR|Opera)/");
    private static final Pattern FIREFOX = Pattern.compile("\\b(Firefox|FxiOS)/");
    private static final Pattern CHROME = Pattern.compile("\\b(Chrome|CriOS|Chromium)/");
    private static final Pattern IOS = Pattern.compile("\\b(iPhone|iPad|iPod)\\b");
    private static final Pattern MAC = Pattern.compile("Macintosh|Mac OS X");

    private PasskeyBrowser() {
    }

    /** The browser and system a User-Agent names; "" when neither is recognised. */
    public static String summary(String userAgent) {
        if (userAgent == null || userAgent.isEmpty()) {
            return "";
        }
        String ua = userAgent.length() > 1024 ? userAgent.substring(0, 1024) : userAgent;
        String browser;
        if (EDGE.matcher(ua).find()) {
            browser = "Edge";
        } else if (OPERA.matcher(ua).find()) {
            browser = "Opera";
        } else if (ua.contains("SamsungBrowser/")) {
            browser = "Samsung Internet";
        } else if (FIREFOX.matcher(ua).find()) {
            browser = "Firefox";
        } else if (CHROME.matcher(ua).find()) {
            browser = "Chrome";
        } else if (ua.contains("Safari/") && ua.contains("Version/")) {
            browser = "Safari";
        } else {
            browser = "";
        }
        String system;
        if (IOS.matcher(ua).find()) {
            system = "iOS";
        } else if (ua.contains("Android")) {
            system = "Android";
        } else if (ua.contains("CrOS")) {
            system = "ChromeOS";
        } else if (ua.contains("Windows")) {
            system = "Windows";
        } else if (MAC.matcher(ua).find()) {
            system = "macOS";
        } else if (ua.contains("Linux")) {
            system = "Linux";
        } else {
            system = "";
        }
        return !browser.isEmpty() && !system.isEmpty() ? browser + " on " + system : browser + system;
    }
}
