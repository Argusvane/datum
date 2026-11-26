package com.argusvane.datum.ui.builder;

import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.FormDefinitionRepository;
import com.argusvane.datum.forms.SavedForm;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import tools.jackson.databind.node.ObjectNode;

/** A writable repository in memory that counts its saves, so a test can prove nothing was stored. */
public final class MemoryRepository implements FormDefinitionRepository {

    private final Map<String, ObjectNode> forms = new ConcurrentHashMap<>();
    private final AtomicInteger saves = new AtomicInteger();

    @Override
    public Optional<ObjectNode> find(String key) {
        ObjectNode found = forms.get(key);
        return found == null ? Optional.empty() : Optional.of(found.deepCopy());
    }

    @Override
    public SavedForm save(ObjectNode definition) {
        String key = definition.get("id").asString();
        forms.put(key, definition.deepCopy());
        saves.incrementAndGet();
        return new SavedForm(key, DefinitionService.hash(definition));
    }

    /** The hashes the builder said it built on, in order (null for a new form). */
    private final List<String> expected = new java.util.concurrent.CopyOnWriteArrayList<>();
    private volatile boolean raceNext;

    /**
     * The conditional save, as a database repository makes it: it records the hash the save builds on, and when a
     * test has said another instance got in first ({@link #raceOnNextSave}) it refuses as the SPI asks.
     */
    @Override
    public SavedForm save(ObjectNode definition, String expectedSha256) {
        expected.add(expectedSha256);
        if (raceNext) {
            raceNext = false;
            ObjectNode current = forms.get(definition.get("id").asString());
            throw new com.argusvane.datum.forms.FormOutdatedException(current == null ? "" : DefinitionService.hash(current));
        }
        return save(definition);
    }

    /** Makes the next conditional save fail as if another instance had replaced the form meanwhile. */
    public void raceOnNextSave() {
        raceNext = true;
    }

    /** The hashes every conditional save built on. */
    public List<String> expectedHashes() {
        return List.copyOf(expected);
    }

    /** Puts a form in place without counting it as a save. */
    public MemoryRepository seed(ObjectNode definition) {
        forms.put(definition.get("id").asString(), definition.deepCopy());
        return this;
    }

    public void clear() {
        forms.clear();
        expected.clear();
        raceNext = false;
        saves.set(0);
    }

    /** How many saves reached the repository. */
    public int saves() {
        return saves.get();
    }

    /** The stored hash of a form, or null. */
    public String hashOf(String key) {
        ObjectNode found = forms.get(key);
        return found == null ? null : DefinitionService.hash(found);
    }
}
