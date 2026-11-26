package com.argusvane.datum.forms.snapshot;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.function.Consumer;
import com.argusvane.datum.core.DatumStartupCheck;
import java.util.List;
import tools.jackson.databind.node.ObjectNode;

/**
 * The default store: a bounded least-recently-used map. It keeps the snapshots only for this process, and
 * forgets the eldest past {@code maxEntries}, so a submission whose version was forgotten cannot be
 * re-resolved. That is fine for trying Datum out and wrong for production, which is why {@link #startupCheck} says so
 * in the start-up report when it is the store in use (a JDBC store, or the application's own bean, replaces it). The
 * constructors write nothing, so a test that builds a store hears nothing. A host that
 * builds the store by hand (any non-Spring binding) must register {@code startupCheck(store)} itself, or production runs unwarned.
 */
public final class InMemoryDefinitionSnapshotStore implements DefinitionSnapshotStore {

    /** The default bound. */
    public static final int DEFAULT_MAX_ENTRIES = 500;

    private final int maxEntries;
    private final Map<String, ObjectNode> entries;

    public InMemoryDefinitionSnapshotStore(int maxEntries) {
        this(maxEntries, message -> { });
    }

    /** @param warn where the warning the old constructor wrote goes (a test's collector); the report is {@link #startupCheck} */
    public InMemoryDefinitionSnapshotStore(int maxEntries, Consumer<String> warn) {
        if (maxEntries < 1) {
            throw new IllegalArgumentException("The snapshot bound must be at least 1.");
        }
        this.maxEntries = maxEntries;
        this.entries = new LinkedHashMap<>(16, 0.75f, true) {
            private static final long serialVersionUID = 1L;

            @Override
            protected boolean removeEldestEntry(Map.Entry<String, ObjectNode> eldest) {
                return size() > InMemoryDefinitionSnapshotStore.this.maxEntries;
            }
        };
        Objects.requireNonNull(warn, "warn").accept(warning(maxEntries));
    }

    private static String warning(int maxEntries) {
        return "Datum keeps form definition snapshots in memory (at most " + maxEntries
            + ", least recently used first out); they are lost on restart, so an older submission's version may not resolve. "
            + "Add spring-jdbc and the datum_definition_snapshot table, or provide a DefinitionSnapshotStore bean.";
    }

    /** The WARN when {@code store} is this one (no JDBC store and no store of the application's own), else nothing. */
    public static DatumStartupCheck startupCheck(DefinitionSnapshotStore store) {
        return () -> store instanceof InMemoryDefinitionSnapshotStore memory
            ? List.of(DatumStartupCheck.Notice.warn(InMemoryDefinitionSnapshotStore.class, warning(memory.maxEntries)))
            : List.of();
    }

    private static String id(String key, String sha256) {
        return key.length() + ":" + key + ":" + sha256;
    }

    @Override
    public synchronized void record(String key, String sha256, ObjectNode definition) {
        entries.putIfAbsent(id(key, sha256), definition.deepCopy());
    }

    @Override
    public synchronized Optional<ObjectNode> find(String key, String sha256) {
        ObjectNode found = entries.get(id(key, sha256));
        return found == null ? Optional.empty() : Optional.of(found.deepCopy());
    }

    /** How many snapshots are held now. */
    public synchronized int size() {
        return entries.size();
    }
}
