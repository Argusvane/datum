package com.argusvane.datum.sandbox.protocol;

import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * The per-form context keys the host decides beside {@code today}, {@code formulaErrors} and
 * {@code riskyPatterns}: what the program does with an answer the form has no component for, and how much of a
 * run's log it keeps. They start from {@code datum.host.unknown-fields} and {@code datum.host.log-level}
 * and a {@link HostOptionsCustomizer} may change them per form.
 *
 * <p>A word the program does not read is refused when it is set ({@link IllegalArgumentException}), as the
 * configuration refuses it at start: a customizer that sets one fails the run like a customizer that throws, rather
 * than quietly running under another policy. An unset value is the kernel's own default ({@code strip}, {@code warn}).
 */
public final class RunSettings {

    /** The unknown-field policies a program reads; {@code strip} is the kernel's default. */
    public static final List<String> UNKNOWN_FIELDS = List.of("strip", "keep", "reject");

    /** The run log levels a program reads; {@code warn} is the kernel's default. */
    public static final List<String> LOG_LEVELS = List.of("off", "error", "warn", "info", "debug");

    private @Nullable String unknownFields;
    private @Nullable String logLevel;

    /**
     * Settings over two words, each one the program reads or null.
     *
     * @throws IllegalArgumentException for a word the program does not read
     */
    public RunSettings(@Nullable String unknownFields, @Nullable String logLevel) {
        this.unknownFields = word("unknownFields", unknownFields, UNKNOWN_FIELDS);
        this.logLevel = word("logLevel", logLevel, LOG_LEVELS);
    }

    /** The policy as set, or null. */
    public @Nullable String getUnknownFields() {
        return unknownFields;
    }

    /** @throws IllegalArgumentException for a word the program does not read */
    public void setUnknownFields(@Nullable String unknownFields) {
        this.unknownFields = word("unknownFields", unknownFields, UNKNOWN_FIELDS);
    }

    /** The log level as set, or null. */
    public @Nullable String getLogLevel() {
        return logLevel;
    }

    /** @throws IllegalArgumentException for a word the program does not read */
    public void setLogLevel(@Nullable String logLevel) {
        this.logLevel = word("logLevel", logLevel, LOG_LEVELS);
    }

    /** The policy the context carries: the one set, else {@code strip}. */
    public String unknownFieldsOrDefault() {
        return unknownFields != null ? unknownFields : "strip";
    }

    /** The level the context carries: the one set, else {@code warn}. */
    public String logLevelOrDefault() {
        return logLevel != null ? logLevel : "warn";
    }

    private static @Nullable String word(String key, @Nullable String value, List<String> allowed) {
        if (value != null && !allowed.contains(value)) {
            throw new IllegalArgumentException(key + " is '" + value + "', which is not one of " + allowed + ".");
        }
        return value;
    }
}
