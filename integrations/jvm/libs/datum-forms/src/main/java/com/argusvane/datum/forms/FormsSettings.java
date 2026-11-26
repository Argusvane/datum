package com.argusvane.datum.forms;

import com.argusvane.datum.core.DatumConfigurationException;
import java.time.Duration;
import java.util.List;

/**
 * {@code datum.forms.*} as one framework-free value with its defaults and checks (integrations/jvm/README.md "Libraries and bindings"): Spring's {@code DatumFormsProperties} and a Quarkus
 * config mapping would both map onto it, and a value out of range fails the start naming the property, whichever host
 * read it.
 *
 * @param locations            resource patterns of the definition files the default repository reads
 * @param snapshotMaxEntries   the most snapshots the in-memory store keeps (least recently used first out)
 * @param publicCopyCacheSize  the most public copies kept, by definition hash
 * @param dataSourceTimeout    how long one data-source provider call may take (15 s by default)
 * @param dataSourceMaxThreads the most provider calls in flight at once; a hung provider can hold this many threads
 * @param tooCostlyMemory      how long a definition the kernel could not check in time is refused without a run (5 min; 1 s to 1 h)
 * @param definitionCacheControl the {@code Cache-Control} of a definition answer ({@code no-store}: a definition may be edited at any time)
 * @param snapshotCacheControl the {@code Cache-Control} of a PUBLIC COPY asked by hash ({@code ?sha256=}): the bytes of a hash never
 *                             change, so the default lets a CDN keep them for a year. A full (non-public) copy is never answered with it
 */
public record FormsSettings(List<String> locations, int snapshotMaxEntries, int publicCopyCacheSize, Duration dataSourceTimeout,
                            int dataSourceMaxThreads, Duration tooCostlyMemory, String definitionCacheControl, String snapshotCacheControl) {
    // Copies: one component changed, the rest kept; the canonical constructor
    // checks the result, so a copy cannot hold what a new value could not. Replaces a positional constructor call that
    // breaks whenever a component is added.

    /** A copy with {@code locations} replaced and every other component kept. */
    public FormsSettings withLocations(List<String> value) {
        return new FormsSettings(value, snapshotMaxEntries, publicCopyCacheSize, dataSourceTimeout, dataSourceMaxThreads, tooCostlyMemory, definitionCacheControl, snapshotCacheControl);
    }

    /** A copy with {@code snapshotMaxEntries} replaced and every other component kept. */
    public FormsSettings withSnapshotMaxEntries(int value) {
        return new FormsSettings(locations, value, publicCopyCacheSize, dataSourceTimeout, dataSourceMaxThreads, tooCostlyMemory, definitionCacheControl, snapshotCacheControl);
    }

    /** A copy with {@code publicCopyCacheSize} replaced and every other component kept. */
    public FormsSettings withPublicCopyCacheSize(int value) {
        return new FormsSettings(locations, snapshotMaxEntries, value, dataSourceTimeout, dataSourceMaxThreads, tooCostlyMemory, definitionCacheControl, snapshotCacheControl);
    }

    /** A copy with {@code dataSourceTimeout} replaced and every other component kept. */
    public FormsSettings withDataSourceTimeout(Duration value) {
        return new FormsSettings(locations, snapshotMaxEntries, publicCopyCacheSize, value, dataSourceMaxThreads, tooCostlyMemory, definitionCacheControl, snapshotCacheControl);
    }

    /** A copy with {@code dataSourceMaxThreads} replaced and every other component kept. */
    public FormsSettings withDataSourceMaxThreads(int value) {
        return new FormsSettings(locations, snapshotMaxEntries, publicCopyCacheSize, dataSourceTimeout, value, tooCostlyMemory, definitionCacheControl, snapshotCacheControl);
    }

    /** A copy with {@code tooCostlyMemory} replaced and every other component kept. */
    public FormsSettings withTooCostlyMemory(Duration value) {
        return new FormsSettings(locations, snapshotMaxEntries, publicCopyCacheSize, dataSourceTimeout, dataSourceMaxThreads, value, definitionCacheControl, snapshotCacheControl);
    }

    /** A copy with {@code definitionCacheControl} replaced and every other component kept. */
    public FormsSettings withDefinitionCacheControl(String value) {
        return new FormsSettings(locations, snapshotMaxEntries, publicCopyCacheSize, dataSourceTimeout, dataSourceMaxThreads, tooCostlyMemory, value, snapshotCacheControl);
    }

    /** A copy with {@code snapshotCacheControl} replaced and every other component kept. */
    public FormsSettings withSnapshotCacheControl(String value) {
        return new FormsSettings(locations, snapshotMaxEntries, publicCopyCacheSize, dataSourceTimeout, dataSourceMaxThreads, tooCostlyMemory, definitionCacheControl, value);
    }

    public static final List<String> DEFAULT_LOCATIONS = List.of("classpath:/datum/forms/*.json");
    public static final int DEFAULT_SNAPSHOT_MAX_ENTRIES = 500;
    public static final int DEFAULT_PUBLIC_COPY_CACHE_SIZE = 256;
    public static final Duration DEFAULT_DATA_SOURCE_TIMEOUT = Duration.ofSeconds(15);
    public static final int DEFAULT_DATA_SOURCE_MAX_THREADS = 16;
    public static final Duration DEFAULT_TOO_COSTLY_MEMORY = Duration.ofSeconds(300);
    public static final Duration MAX_TOO_COSTLY_MEMORY = Duration.ofHours(1);
    public static final String DEFAULT_DEFINITION_CACHE_CONTROL = "no-store";

    /** @throws IllegalArgumentException naming the property, for a count below 1 or a timeout that is not positive */
    public FormsSettings {
        locations = locations == null ? List.of() : List.copyOf(locations);
        requireAtLeastOne("datum.forms.snapshots.max-entries", snapshotMaxEntries);
        requireAtLeastOne("datum.forms.snapshots.public-copy-cache-size", publicCopyCacheSize);
        requirePositive("datum.forms.data-sources.timeout", dataSourceTimeout);
        requireAtLeastOne("datum.forms.data-sources.max-threads", dataSourceMaxThreads);
        tooCostlyMemory = tooCostlyMemory == null ? DEFAULT_TOO_COSTLY_MEMORY : tooCostlyMemory;
        if (tooCostlyMemory.compareTo(Duration.ofSeconds(1)) < 0 || tooCostlyMemory.compareTo(MAX_TOO_COSTLY_MEMORY) > 0) {
            throw new DatumConfigurationException("datum.forms.too-costly-memory", "datum.forms.too-costly-memory is " + tooCostlyMemory + "; it must be from 1 s to 1 h.");
        }
        definitionCacheControl = requireHeaderValue("datum.forms.cache.definition", definitionCacheControl, DEFAULT_DEFINITION_CACHE_CONTROL);
        snapshotCacheControl = requireHeaderValue("datum.forms.cache.snapshot", snapshotCacheControl, definitionCacheControl);
    }

    /** What an application that set nothing runs with. */
    public static FormsSettings defaults() {
        return new FormsSettings(DEFAULT_LOCATIONS, DEFAULT_SNAPSHOT_MAX_ENTRIES, DEFAULT_PUBLIC_COPY_CACHE_SIZE, DEFAULT_DATA_SOURCE_TIMEOUT,
            DEFAULT_DATA_SOURCE_MAX_THREADS, DEFAULT_TOO_COSTLY_MEMORY, DEFAULT_DEFINITION_CACHE_CONTROL, null);
    }

    /**
     * A header value as configured: unset is the default; a blank one or one with a control character (a line break would
     * split the response) stops the start naming the property.
     */
    private static String requireHeaderValue(String name, String value, String fallback) {
        if (value == null) {
            return fallback;
        }
        String stripped = value.strip();
        if (stripped.isEmpty() || stripped.chars().anyMatch(c -> c < 0x20 || c == 0x7f)) {
            throw new IllegalArgumentException(name + " must be a Cache-Control value without line breaks, not \"" + value + "\".");
        }
        return stripped;
    }

    /** @throws IllegalArgumentException naming the property when {@code value} is below 1 */
    public static int requireAtLeastOne(String name, int value) {
        if (value < 1) {
            throw new IllegalArgumentException(name + " must be at least 1, not " + value + ".");
        }
        return value;
    }

    /** @throws IllegalArgumentException naming the property when the duration is missing, zero or negative */
    public static Duration requirePositive(String name, Duration value) {
        if (value == null || value.isZero() || value.isNegative()) {
            throw new IllegalArgumentException(name + " must be a positive duration.");
        }
        return value;
    }
}
