package com.argusvane.datum.starter.test;

import java.util.Set;
import java.util.TreeSet;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Reads springdoc's per-group OpenAPI documents. Datum defines one group per capability
 * ({@code datum-forms}, {@code datum-submissions}, {@code datum-ui}, {@code datum-pdf}, {@code datum-tsa},
 * {@code datum-webauthn}), served at {@code /v3/api-docs/<group>}; a test asserts the document lists exactly the
 * routes the configuration enables.
 */
public final class DatumApiDocs {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    private DatumApiDocs() {
    }

    /** The URL of a group's document. */
    public static String url(String group) {
        return "/v3/api-docs/" + group;
    }

    /** The paths a document lists, sorted. */
    public static Set<String> paths(String document) {
        JsonNode paths = JSON.readTree(document).path("paths");
        Set<String> found = new TreeSet<>();
        paths.propertyNames().forEach(found::add);
        return found;
    }

    /** The {@code METHOD path} pairs a document lists, sorted, e.g. {@code GET /api/forms/{key}/definition}. */
    public static Set<String> operations(String document) {
        Set<String> found = new TreeSet<>();
        JSON.readTree(document).path("paths").properties().forEach(path -> path.getValue().propertyNames().forEach(method -> {
            if (Set.of("get", "put", "post", "delete", "patch", "head", "options").contains(method)) {
                found.add(method.toUpperCase(java.util.Locale.ROOT) + " " + path.getKey());
            }
        }));
        return found;
    }
}
