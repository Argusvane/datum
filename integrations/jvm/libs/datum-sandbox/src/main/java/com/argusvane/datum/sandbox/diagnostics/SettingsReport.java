package com.argusvane.datum.sandbox.diagnostics;

import java.util.List;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * The settings the sandbox runs with, one {@link Entry} per property key: the value in force, and whether it is the default,
 * was configured, or was clamped to a bound. {@code SandboxSettings#explain()} builds it; nothing
 * here reads configuration.
 *
 * <p>The clamp warnings a host logs at start are the entries' own {@link Entry#warnings()}, so what the log said and what
 * the report says cannot drift apart. {@link #toString()} is the block an operator reads, one line per key.
 *
 * @param entries every key, in the order the settings are documented
 */
public record SettingsReport(List<Entry> entries) {

    public SettingsReport {
        entries = List.copyOf(Objects.requireNonNull(entries, "entries"));
    }

    /** Where a value in force came from. */
    public enum Source {
        /** Nothing was set, or what was set is the default itself. */
        DEFAULT,
        /** Set, and used as set. */
        CONFIGURED,
        /** Set, and not used as set: a bound or a rounding changed it ({@link Entry#asked()} and {@link Entry#bound()} say how). */
        CLAMPED,
        /**
         * Not read from the settings at all: the application supplied the input this value comes from in their place (its own
         * limits, host options, engine settings or runtime), and the value is what that input holds.
         * Only the running sandbox's report ({@code DatumSandbox#explain()}) says this; the settings' own never do.
         */
        REPLACED
    }

    /**
     * One property key.
     *
     * @param key the property key, as an operator writes it ({@code datum.runtime.validation.time-limit})
     * @param value the effective value; its {@code toString()} is what the report prints
     * @param source where it came from
     * @param asked what was asked for when {@code source} is {@link Source#CLAMPED}, else null
     * @param bound the rule that changed it when {@code source} is {@link Source#CLAMPED} ({@code [1, 60] seconds}), else null
     * @param warnings the WARN texts a host logs for this key, empty unless it was clamped
     * @param resolved what a setting that is a rule rather than a number comes to here (a concurrency of 0: one slot per CPU),
     *     or null; the value stays the setting as it is, so a JSON reader always finds the same type under {@code value}
     */
    public record Entry(String key, Object value, Source source, @Nullable Object asked, @Nullable String bound, List<String> warnings,
                        @Nullable Resolved resolved) {

        public Entry {
            Objects.requireNonNull(key, "key");
            Objects.requireNonNull(value, "value");
            Objects.requireNonNull(source, "source");
            warnings = List.copyOf(Objects.requireNonNull(warnings, "warnings"));
        }

        /** An entry with nothing resolved. */
        public Entry(String key, Object value, Source source, @Nullable Object asked, @Nullable String bound, List<String> warnings) {
            this(key, value, source, asked, bound, warnings, null);
        }

        /** A key left at its default. */
        public static Entry defaulted(String key, Object value) {
            return new Entry(key, value, Source.DEFAULT, null, null, List.of());
        }

        /** A key set to a value of its own and used as set. */
        public static Entry configured(String key, Object value) {
            return new Entry(key, value, Source.CONFIGURED, null, null, List.of());
        }

        /** A key whose asked value was changed to {@code value} by {@code bound}, with the texts to log. */
        public static Entry clamped(String key, Object value, Object asked, String bound, List<String> warnings) {
            return new Entry(key, value, Source.CLAMPED, asked, bound, warnings);
        }

        /** A key whose value is what an input the application supplied in place of the settings holds. */
        public static Entry replaced(String key, Object value) {
            return new Entry(key, value, Source.REPLACED, null, null, List.of());
        }

        /** The same key, value and provenance with what the setting comes to here ({@code rule = count}). */
        public Entry withResolved(String rule, long count) {
            return new Entry(key, value, source, asked, bound, warnings, new Resolved(rule, count));
        }

        /**
         * The entry as one line: {@code key = value (default)}, {@code (configured)}, {@code (clamped from X to bound)}, or
         * {@code (replaced by the application's own input)}; a resolved setting prints what it comes to after the value,
         * {@code key = 0 (one per CPU = 8) (default)}.
         */
        @Override
        public String toString() {
            String how = switch (source) {
                case DEFAULT -> "default";
                case CONFIGURED -> "configured";
                case CLAMPED -> "clamped from " + asked + (bound == null ? "" : " to " + bound);
                case REPLACED -> "replaced by the application's own input";
            };
            return key + " = " + value + (resolved == null ? "" : " (" + resolved.rule() + " = " + resolved.count() + ")") + " (" + how + ")";
        }
    }

    /**
     * What a setting given as a rule comes to on this host.
     *
     * @param rule the rule in words ({@code one per CPU})
     * @param count what it comes to
     */
    public record Resolved(String rule, long count) {

        public Resolved {
            Objects.requireNonNull(rule, "rule");
        }
    }

    /** The entry of a key, or null. */
    public @Nullable Entry get(String key) {
        for (Entry entry : entries) {
            if (entry.key().equals(key)) {
                return entry;
            }
        }
        return null;
    }

    /** The same report with the entry of each key in {@code replacements} swapped for that one, in place. */
    public SettingsReport with(List<Entry> replacements) {
        List<Entry> out = new java.util.ArrayList<>(entries.size());
        for (Entry entry : entries) {
            Entry swapped = entry;
            for (Entry replacement : replacements) {
                if (replacement.key().equals(entry.key())) {
                    swapped = replacement;
                }
            }
            out.add(swapped);
        }
        return new SettingsReport(out);
    }

    /** Every clamp warning text, in key order: what a host logs at start. */
    public List<String> warnings() {
        return entries.stream().flatMap(entry -> entry.warnings().stream()).toList();
    }

    /** The report as a readable block: a heading, then one indented line per key. */
    @Override
    public String toString() {
        StringBuilder text = new StringBuilder("Datum sandbox settings:");
        for (Entry entry : entries) {
            text.append("\n  ").append(entry);
        }
        return text.toString();
    }
}
