package com.argusvane.datum.core;

import java.util.regex.Pattern;

/**
 * The form key rule, in the one library every other depends on: 1 to 128 letters, digits, dots, hyphens or
 * underscores (a URL path segment and the snapshot table's {@code form_key VARCHAR(128)}). {@code FormKeys} in
 * datum-forms applies it to definition files, and the binding table ({@code HostBindings}) to its route keys, so a
 * form the store accepts can always be given a route.
 */
public final class FormKeyRule {

    /** {@code ^[A-Za-z0-9_.-]{1,128}$}. */
    public static final Pattern PATTERN = Pattern.compile("^[A-Za-z0-9_.-]{1,128}$");

    private FormKeyRule() {
    }

    /** Whether {@code key} is a form key. */
    public static boolean isValid(String key) {
        return key != null && PATTERN.matcher(key).matches();
    }
}
