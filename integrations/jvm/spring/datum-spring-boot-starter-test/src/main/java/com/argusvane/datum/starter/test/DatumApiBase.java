package com.argusvane.datum.starter.test;

import org.springframework.core.env.Environment;

/** The API base the test helpers use: the application's {@code datum.web.api.path}, {@code /api} when it sets none. */
final class DatumApiBase {

    static final String DEFAULT = "/api";

    private DatumApiBase() {
    }

    static String of(Environment environment) {
        String path = environment.getProperty("datum.web.api.path", DEFAULT);
        String trimmed = path.strip();
        while (trimmed.length() > 1 && trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed.isEmpty() ? DEFAULT : trimmed;
    }
}
