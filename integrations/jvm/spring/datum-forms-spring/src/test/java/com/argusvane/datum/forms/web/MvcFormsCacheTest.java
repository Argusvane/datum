package com.argusvane.datum.forms.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.Fixtures;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;

/**
 * {@code datum.forms.cache.definition} and {@code datum.forms.cache.snapshot}: the definition answers keep
 * {@code no-store} by default (the contract test), a public copy asked by hash is the one answer a shared cache may keep, and a
 * full (non-public) copy never takes the snapshot value, however it is asked.
 */
@SpringBootTest(classes = FormsMvcTestApp.class, properties = {
    "datum.web.api.endpoints.definition=true",
    "datum.forms.cache.definition=private, max-age=30",
    "datum.forms.cache.snapshot=public, max-age=600",
    "spring.main.web-application-type=servlet"})
@AutoConfigureMockMvc
class MvcFormsCacheTest {

    private static final String FULL_SHA = DefinitionService.hash(Fixtures.endpointFixture());

    @Autowired
    MockMvc mvc;

    @Test
    void theCurrentDefinitionAndAFullCopyTakeTheDefinitionHeader() {
        assertThat(MvcTransport.get(mvc, "/api/forms/endpoint/definition").headers().getFirst("Cache-Control")).isEqualTo("private, max-age=30");
        assertThat(MvcTransport.get(mvc, "/api/forms/endpoint/definition?public=false").headers().getFirst("Cache-Control"))
            .isEqualTo("private, max-age=30");
        Reply full = MvcTransport.get(mvc, "/api/forms/endpoint/definition?public=false&sha256=" + FULL_SHA);
        assertThat(full.status()).isEqualTo(200);
        assertThat(full.headers().getFirst("Cache-Control")).as("a full copy by hash is still the author's").isEqualTo("private, max-age=30");
    }

    @Test
    void aPublicCopyByHashTakesTheSnapshotHeaderOnAnswerAndOnTheNotModified() {
        Reply byHash = MvcTransport.get(mvc, "/api/forms/endpoint/definition?sha256=" + FULL_SHA);
        assertThat(byHash.status()).isEqualTo(200);
        assertThat(byHash.headers().getFirst("Cache-Control")).isEqualTo("public, max-age=600");
        Reply notModified = MvcTransport.get(mvc, "/api/forms/endpoint/definition?sha256=" + FULL_SHA, "If-None-Match",
            byHash.headers().getFirst("ETag"));
        assertThat(notModified.status()).isEqualTo(304);
        assertThat(notModified.headers().getFirst("Cache-Control")).isEqualTo("public, max-age=600");
    }
}
