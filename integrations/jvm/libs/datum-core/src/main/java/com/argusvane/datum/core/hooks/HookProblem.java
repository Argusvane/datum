package com.argusvane.datum.core.hooks;

import java.util.Objects;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * One thing a hook found wrong (or worth saying) about a request: the wire's {@code {field, code, message}} entry.
 *
 * @param field what it is about (a component id, a path, a member), or null for the request as a whole
 * @param code the stable machine code, the application's own ({@code tenant.prefix}, {@code pdf.pages}); letters,
 *     digits, {@code . _ : -}, starting with a letter, at most 128
 * @param message host-worded text for a person, or null; never anything a guest printed
 */
public record HookProblem(@Nullable String field, String code, @Nullable String message) {

    /** What a code may hold: it is written into JSON bodies, logs and meter tags. */
    private static final Pattern CODE = Pattern.compile("[A-Za-z][A-Za-z0-9._:-]{0,127}");

    public HookProblem {
        Objects.requireNonNull(code, "code");
        if (!CODE.matcher(code).matches()) {
            throw new IllegalArgumentException("A hook's code holds letters, digits and . _ : - (starting with a letter, at most 128), not \""
                + code + "\".");
        }
    }

    /** A problem of the request as a whole. */
    public static HookProblem of(String code, @Nullable String message) {
        return new HookProblem(null, code, message);
    }

    /** A problem of one field (a component id, a path). */
    public static HookProblem at(@Nullable String field, String code, @Nullable String message) {
        return new HookProblem(field, code, message);
    }
}
