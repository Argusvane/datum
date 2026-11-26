package com.argusvane.datum.submissions;

import com.argusvane.datum.sandbox.protocol.StrictJson;
import com.argusvane.datum.forms.FormDefinitionRepository;
import com.argusvane.datum.forms.FormStoreReadOnlyException;
import com.argusvane.datum.forms.SavedForm;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/** Definitions, envelopes and bodies for the tests. */
public final class Fixtures {

    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

    private Fixtures() {
    }

    public static ObjectNode json(String text) {
        try {
            return (ObjectNode) StrictJson.decode(text);
        } catch (StrictJson.NotJsonException e) {
            throw new AssertionError(e);
        }
    }

    /** A one-field form without journeys, version "1". */
    public static ObjectNode contact() {
        return json("{\"id\":\"contact\",\"version\":\"1\",\"root\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{},"
            + "\"children\":{\"content\":[{\"id\":\"name\",\"type\":\"text\",\"configuration\":{\"label\":\"Name\",\"required\":true}},"
            + "{\"id\":\"city\",\"type\":\"text\",\"configuration\":{}}]}}}");
    }

    /** A form with one journey "main" of two pages (p1: name, p2: city) and an exit page, version "2". */
    public static ObjectNode trip() {
        return json("{\"id\":\"trip\",\"version\":\"2\",\"root\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{},"
            + "\"children\":{\"content\":[{\"id\":\"name\",\"type\":\"text\",\"configuration\":{\"required\":true}},"
            + "{\"id\":\"city\",\"type\":\"text\",\"configuration\":{}}]}},"
            + "\"journey\":{\"journeys\":[{\"id\":\"main\",\"pages\":[{\"id\":\"p1\",\"components\":[\"name\"]},"
            + "{\"id\":\"p2\",\"components\":[\"city\"]},{\"id\":\"stop\",\"kind\":\"exit\",\"components\":[]}]}]}}");
    }

    /** A form with two journeys and no default, version "3". */
    public static ObjectNode twoJourneys() {
        return json("{\"id\":\"pick\",\"version\":\"3\",\"root\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{},"
            + "\"children\":{\"content\":[{\"id\":\"name\",\"type\":\"text\",\"configuration\":{}}]}},"
            + "\"journey\":{\"journeys\":[{\"id\":\"a\",\"pages\":[{\"id\":\"p1\",\"components\":[\"name\"]}]},"
            + "{\"id\":\"b\",\"pages\":[{\"id\":\"p1\",\"components\":[\"name\"]}]}]}}");
    }

    /** A form whose choice names the data source "colours", version "1". */
    public static ObjectNode sourced() {
        return json("{\"id\":\"sourced\",\"version\":\"1\",\"root\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{},"
            + "\"children\":{\"content\":[{\"id\":\"colour\",\"type\":\"select\",\"configuration\":{\"data\":{\"sourceId\":\"colours\"}}}]}}}");
    }

    /** An envelope for a form at a version, with these values. */
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

    /** {@code {"document": document}} as bytes. */
    public static byte[] wrapped(ObjectNode document) {
        ObjectNode body = NODES.objectNode();
        body.set("document", document);
        return bytes(body);
    }

    /** {@code {"document": document, "submissionKey": <fresh UUID>}} as bytes: a delivery, one submit attempt. */
    public static byte[] delivered(ObjectNode document) {
        return delivered(document, java.util.UUID.randomUUID().toString());
    }

    /** {@code {"document": document, "submissionKey": key}} as bytes: a retry of one attempt sends the same key. */
    public static byte[] delivered(ObjectNode document, String submissionKey) {
        ObjectNode body = NODES.objectNode();
        body.set("document", document);
        body.put("submissionKey", submissionKey);
        return bytes(body);
    }

    /** A check body {@code {document, scope, pageId?}}. */
    public static byte[] check(ObjectNode document, String scope, String pageId) {
        ObjectNode body = NODES.objectNode();
        body.set("document", document);
        body.put("scope", scope);
        if (pageId != null) {
            body.put("pageId", pageId);
        }
        return bytes(body);
    }

    public static byte[] bytes(ObjectNode node) {
        return StrictJson.encode(node).getBytes(StandardCharsets.UTF_8);
    }

    public static byte[] bytes(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    /** A read-only repository over definitions, counting its reads. */
    public static final class Repository implements FormDefinitionRepository {

        private final Map<String, ObjectNode> forms = new LinkedHashMap<>();
        public final AtomicInteger reads = new AtomicInteger();

        public Repository(ObjectNode... definitions) {
            for (ObjectNode definition : definitions) {
                forms.put(definition.path("id").stringValue(), definition);
            }
        }

        @Override
        public Optional<ObjectNode> find(String key) {
            reads.incrementAndGet();
            ObjectNode definition = forms.get(key);
            return definition == null ? Optional.empty() : Optional.of(definition.deepCopy());
        }

        @Override
        public SavedForm save(ObjectNode definition) {
            throw new FormStoreReadOnlyException();
        }

        @Override
        public SavedForm save(ObjectNode definition, String expectedSha256) {
            throw new FormStoreReadOnlyException();
        }
    }
}
