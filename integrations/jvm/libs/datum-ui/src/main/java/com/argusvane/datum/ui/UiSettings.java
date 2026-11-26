package com.argusvane.datum.ui;

import com.argusvane.datum.core.DatumConfigurationException;

/**
 * {@code datum.builder.*}: whether this application is a place where forms are authored, as one framework-free
 * value (integrations/jvm/README.md "Libraries and bindings").
 *
 * <p>Off by default. A visitor-facing site serves the form bundle only; the builder bundle (about 1.4 MB plus its
 * chunks and fonts) and the write endpoints exist when the builder is on. The asset gate and the write endpoints
 * read the same value, so they cannot disagree about the switch.
 *
 * @param builderEnabled     serve the builder bundle and register the form write endpoints
 * @param maxDefinitionBytes the largest definition a save reads, counted on the raw stream before parsing (413 over it)
 */
public record UiSettings(boolean builderEnabled, long maxDefinitionBytes) {
    // Copies: one component changed, the rest kept; the canonical constructor
    // checks the result, so a copy cannot hold what a new value could not. Replaces a positional constructor call that
    // breaks whenever a component is added.

    /** A copy with {@code builderEnabled} replaced and every other component kept. */
    public UiSettings withBuilderEnabled(boolean value) {
        return new UiSettings(value, maxDefinitionBytes);
    }

    /** A copy with {@code maxDefinitionBytes} replaced and every other component kept. */
    public UiSettings withMaxDefinitionBytes(long value) {
        return new UiSettings(builderEnabled, value);
    }

    /** One mebibyte. */
    public static final long DEFAULT_MAX_DEFINITION_BYTES = 1_048_576L;

    /**
     * The largest cap that can be configured: 64 MiB. Every run carries the whole definition, so a cap beyond this only invites
     * a request that holds a parser and a sandbox for no real form.
     */
    public static final long MAX_MAX_DEFINITION_BYTES = 64L * 1_048_576L;

    public UiSettings {
        if (maxDefinitionBytes < 1 || maxDefinitionBytes > MAX_MAX_DEFINITION_BYTES) {
            throw new DatumConfigurationException("datum.builder.max-definition-size", "datum.builder.max-definition-size is " + maxDefinitionBytes + "B; it must be from 1B to "
                + MAX_MAX_DEFINITION_BYTES + "B (64 MiB).");
        }
    }

    /** What an application that set nothing runs with: no builder, 1 MiB. */
    public static UiSettings defaults() {
        return new UiSettings(false, DEFAULT_MAX_DEFINITION_BYTES);
    }
}
