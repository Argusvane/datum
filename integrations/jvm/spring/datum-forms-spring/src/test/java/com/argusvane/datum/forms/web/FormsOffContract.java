package com.argusvane.datum.forms.web;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Set;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

/**
 * No forms endpoint switched on (every endpoint is off by default, so the application sets nothing): the routes are absent (404, not 403), the application's own error handling answers, and the
 * OpenAPI group lists no paths.
 */
public abstract class FormsOffContract {

    protected abstract Reply get(String path, String... headers);

    @Test
    void switchedOffEndpointsAreAbsent() {
        for (String path : new String[] {"/api/forms/endpoint/definition", "/api/forms/endpoint/translations", "/api/data-sources/colours", "/api/forms"}) {
            Reply reply = get(path);
            assertThat(reply.status()).as(path).isEqualTo(404);
            assertThat(reply.text()).as(path).doesNotContain("form.notFound", "data_source.notFound");
        }
    }

    @Test
    void theDocumentListsNoPaths() {
        Reply doc = get("/v3/api-docs/datum-forms");
        assertThat(doc.status()).isEqualTo(200);
        JsonNode paths = doc.json().path("paths");
        Set<String> names = new java.util.TreeSet<>();
        paths.propertyNames().forEach(names::add);
        assertThat(names).isEmpty();
    }
}
