package com.argusvane.datum.starter.test;

import com.argusvane.datum.core.canonical.CanonicalJson;
import com.argusvane.datum.sandbox.protocol.StrictJson;
import com.argusvane.datum.forms.FormDefinitionRepository;
import com.argusvane.datum.forms.FormOutdatedException;
import com.argusvane.datum.forms.SavedForm;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * Fixture form definitions for tests, and the in-memory {@link FormDefinitionRepository} that serves them.
 *
 * <p>The definitions are small on purpose: they are what a test needs to see an endpoint answer, not a model of a
 * real form. {@link #contact()} is one required field, {@link #trip()} a one-journey form, {@link #secret()} a form
 * with a rule marked {@code server-secret} (its public copy has no rule), {@link #sourced()} a choice that names a
 * data source. Each call returns a fresh object a test may change.
 */
public final class DatumTestForms {

    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

    private DatumTestForms() {
    }

    /** Parses definition text; a test fixture that is not JSON is a bug, not a case. */
    public static ObjectNode json(String text) {
        try {
            return (ObjectNode) StrictJson.decode(text);
        } catch (StrictJson.NotJsonException | ClassCastException e) {
            throw new AssertionError("The fixture is not a JSON object: " + e.getMessage(), e);
        }
    }

    /** A form with a required name and an optional city, version "1". */
    public static ObjectNode contact() {
        return json("{\"id\":\"contact\",\"version\":\"1\",\"root\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{\"title\":\"Contact\"},"
            + "\"children\":{\"content\":[{\"id\":\"name\",\"type\":\"text\",\"configuration\":{\"label\":\"Name\",\"required\":true}},"
            + "{\"id\":\"city\",\"type\":\"text\",\"configuration\":{\"label\":\"City\"}}]}}}");
    }

    /** A form with one journey "main" of two pages (p1: name, p2: city) and an exit page, version "2". */
    public static ObjectNode trip() {
        return json("{\"id\":\"trip\",\"version\":\"2\",\"root\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{\"title\":\"Trip\"},"
            + "\"children\":{\"content\":[{\"id\":\"name\",\"type\":\"text\",\"configuration\":{\"required\":true}},"
            + "{\"id\":\"city\",\"type\":\"text\",\"configuration\":{}}]}},"
            + "\"journey\":{\"journeys\":[{\"id\":\"main\",\"pages\":[{\"id\":\"p1\",\"components\":[\"name\"]},"
            + "{\"id\":\"p2\",\"components\":[\"city\"]},{\"id\":\"stop\",\"kind\":\"exit\",\"components\":[]}]}]}}");
    }

    /** A form whose choice names the data source "colours", version "1". */
    public static ObjectNode sourced() {
        return json("{\"id\":\"sourced\",\"version\":\"1\",\"root\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{\"title\":\"Sourced\"},"
            + "\"children\":{\"content\":[{\"id\":\"colour\",\"type\":\"select\",\"configuration\":{\"data\":{\"sourceId\":\"colours\"}}}]}}}");
    }

    /** A form with a server-secret rule, version "1": the public copy a browser gets has no {@code rules}. */
    public static ObjectNode secret() {
        return json("{\"id\":\"secret\",\"version\":\"1\",\"root\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{\"title\":\"Secret\"},"
            + "\"children\":{\"content\":[{\"id\":\"code\",\"type\":\"text\",\"configuration\":{\"label\":\"Code\"}}]}},"
            + "\"rules\":{\"codeKnown\":{\"run\":\"server-secret\",\"when\":\"code = 1\"}}}");
    }

    /** All the fixtures, in key order. */
    public static List<ObjectNode> all() {
        return List.of(contact(), secret(), sourced(), trip());
    }

    /**
     * An envelope as the browser posts it: the form and version it was drawn from, the client's versions and these
     * values (JSON text of an object).
     */
    public static ObjectNode envelope(String formId, String version, String values) {
        ObjectNode envelope = NODES.objectNode();
        ObjectNode context = envelope.putObject("versionContext");
        ObjectNode form = context.putObject("form");
        form.put("id", formId);
        form.put("version", version);
        ObjectNode client = context.putObject("client");
        client.put("runtimeVersion", "test");
        client.put("rendererVersion", "test");
        client.put("schemaVersion", "1");
        ObjectNode submission = envelope.putObject("submission");
        submission.put("locale", "en");
        submission.set("values", json(values));
        return envelope;
    }

    /** The envelope of {@link #contact()} with a name and a city. */
    public static ObjectNode contactEnvelope(String name, String city) {
        ObjectNode values = NODES.objectNode();
        values.put("name", name);
        values.put("city", city);
        return envelope("contact", "1", StrictJson.encode(values));
    }

    /** The JSON bytes of a node, for a request body. */
    public static byte[] bytes(ObjectNode node) {
        return StrictJson.encode(node).getBytes(StandardCharsets.UTF_8);
    }

    /** A repository over {@link #all()}. */
    public static Repository repository() {
        return new Repository(all());
    }

    /** An in-memory repository: finds, lists (case-insensitive over key and title) and saves. */
    public static final class Repository implements FormDefinitionRepository {

        private final Map<String, ObjectNode> forms = new ConcurrentHashMap<>();

        public Repository(List<ObjectNode> definitions) {
            definitions.forEach(this::save);
        }

        @Override
        public Optional<ObjectNode> find(String key) {
            ObjectNode definition = forms.get(key);
            return definition == null ? Optional.empty() : Optional.of(definition.deepCopy());
        }

        @Override
        public SavedForm save(ObjectNode definition) {
            String key = definition.path("id").asString("");
            forms.put(key, definition.deepCopy());
            return new SavedForm(key, CanonicalJson.digest(definition));
        }

        /**
         * The conditional save: the stored hash must still be {@code expectedSha256} (null: the form must not exist), else
         * {@link FormOutdatedException} with the hash that is current.
         */
        @Override
        public synchronized SavedForm save(ObjectNode definition, String expectedSha256) {
            ObjectNode existing = forms.get(definition.path("id").asString(""));
            String current = existing == null ? null : CanonicalJson.digest(existing);
            if (current == null ? expectedSha256 != null : !current.equals(expectedSha256)) {
                throw new FormOutdatedException(current == null ? "" : current);
            }
            return save(definition);
        }
    }
}
