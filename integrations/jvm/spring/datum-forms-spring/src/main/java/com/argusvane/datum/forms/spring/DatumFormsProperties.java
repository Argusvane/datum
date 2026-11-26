package com.argusvane.datum.forms.spring;

import com.argusvane.datum.forms.FormsSettings;
import java.time.Duration;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * {@code datum.forms.*}. Builder and endpoint switches ({@code datum.builder.*}, {@code datum.web.api.*}) belong to the other modules.
 *
 * <p>The Spring binding of {@link FormsSettings}: the checks are the record's, and
 * {@link #toSettings()} is what the library reads. The defaults stay literals here so the configuration metadata
 * names them; a test holds them equal to {@link FormsSettings#defaults()}.
 */
@ConfigurationProperties("datum.forms")
public class DatumFormsProperties {

    /** Spring resource patterns of the definition files the default repository reads. */
    private List<String> locations = List.of("classpath:/datum/forms/*.json");

    /** The snapshot store and the public-copy cache. */
    private final Snapshots snapshots = new Snapshots();

    /** Data-source calls. */
    private final DataSources dataSources = new DataSources();

    /**
     * How long a definition the kernel could not check in time is refused without another run. From 1 s to 1 h; outside that
     * the start stops naming this property.
     */
    private Duration tooCostlyMemory = FormsSettings.DEFAULT_TOO_COSTLY_MEMORY;

    /** The Cache-Control values of the definition answers. */
    private final Cache cache = new Cache();

    public List<String> getLocations() {
        return locations;
    }

    public void setLocations(List<String> locations) {
        this.locations = locations == null ? List.of() : List.copyOf(locations);
    }

    public Snapshots getSnapshots() {
        return snapshots;
    }

    public DataSources getDataSources() {
        return dataSources;
    }

    public Duration getTooCostlyMemory() {
        return tooCostlyMemory;
    }

    public void setTooCostlyMemory(Duration tooCostlyMemory) {
        this.tooCostlyMemory = tooCostlyMemory;
    }

    public Cache getCache() {
        return cache;
    }

    /** These properties as the library's settings. */
    public FormsSettings toSettings() {
        return new FormsSettings(locations, snapshots.getMaxEntries(), snapshots.getPublicCopyCacheSize(), dataSources.getTimeout(),
            dataSources.getMaxThreads(), tooCostlyMemory, cache.getDefinition(), cache.getSnapshot());
    }

    /** {@code datum.forms.cache.*}: the caching headers of the definition endpoint. */
    public static class Cache {

        /**
         * The Cache-Control of a definition answer (the current definition, or a full copy). The default is no-store: a definition
         * can change at any save.
         */
        private String definition = FormsSettings.DEFAULT_DEFINITION_CACHE_CONTROL;

        /**
         * The Cache-Control of the PUBLIC copy of a version asked by hash (sha256 parameter). Unset follows
         * {@code definition} (no-store). Opt in to a cacheable value only when the read routes are unauthenticated: a shared cache
         * may then keep the answer, and the kernel can change a public copy's bytes under the same hash after an upgrade.
         */
        private String snapshot;

        public String getDefinition() {
            return definition;
        }

        public void setDefinition(String definition) {
            this.definition = definition;
        }

        public String getSnapshot() {
            return snapshot;
        }

        public void setSnapshot(String snapshot) {
            this.snapshot = snapshot;
        }
    }

    /** Snapshot and public-copy bounds. */
    public static class Snapshots {

        /** The most snapshots the in-memory store keeps (least recently used first out). */
        private int maxEntries = 500;

        /** The most public copies kept, by definition hash. */
        private int publicCopyCacheSize = 256;

        public int getMaxEntries() {
            return maxEntries;
        }

        public void setMaxEntries(int maxEntries) {
            requireAtLeastOne("datum.forms.snapshots.max-entries", maxEntries);
            this.maxEntries = maxEntries;
        }

        public int getPublicCopyCacheSize() {
            return publicCopyCacheSize;
        }

        public void setPublicCopyCacheSize(int publicCopyCacheSize) {
            requireAtLeastOne("datum.forms.snapshots.public-copy-cache-size", publicCopyCacheSize);
            this.publicCopyCacheSize = publicCopyCacheSize;
        }
    }

    /** Data-source call limits. */
    public static class DataSources {

        /** How long one provider call may take: 15 s by default. */
        private Duration timeout = Duration.ofSeconds(15);

        /** The most provider calls in flight at once; a hung provider can hold this many threads. */
        private int maxThreads = 16;

        public Duration getTimeout() {
            return timeout;
        }

        public void setTimeout(Duration timeout) {
            this.timeout = FormsSettings.requirePositive("datum.forms.data-sources.timeout", timeout);
        }

        public int getMaxThreads() {
            return maxThreads;
        }

        public void setMaxThreads(int maxThreads) {
            requireAtLeastOne("datum.forms.data-sources.max-threads", maxThreads);
            this.maxThreads = maxThreads;
        }
    }

    private static void requireAtLeastOne(String name, int value) {
        FormsSettings.requireAtLeastOne(name, value);
    }
}
