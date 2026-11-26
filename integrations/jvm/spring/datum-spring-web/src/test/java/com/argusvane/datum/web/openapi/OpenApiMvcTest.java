package com.argusvane.datum.web.openapi;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.springweb.mvc.MvcTestApp;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Springdoc on the test classpath: a stand-in capability defines its group through {@link DatumOpenApiSupport}
 * (ordered before springdoc), and the document carries Datum's shared pieces.
 */
@SpringBootTest(classes = MvcTestApp.class, properties = {
    "datum.test.docs=true",
    "spring.main.web-application-type=servlet"})
@AutoConfigureMockMvc
class OpenApiMvcTest {

    @Autowired
    MockMvc mvc;

    @Autowired
    DatumOpenApiRegistry registry;

    private JsonNode get(String path) throws Exception {
        String body = mvc.perform(MockMvcRequestBuilders.get(path)).andReturn().getResponse().getContentAsString();
        return JsonMapper.builder().build().readTree(body);
    }

    @Test
    void theGroupIsListedAndRegistered() throws Exception {
        assertThat(registry.groups()).extracting(DatumOpenApiRegistry.Group::name).containsExactly("datum-test");
        assertThat(registry.groups().get(0).disabledPaths()).containsExactly("/test/hidden/**");
    }

    @Test
    void theDocumentCarriesTheSharedSchemasHeadersAndResponses() throws Exception {
        JsonNode doc = get("/v3/api-docs/datum-test");
        JsonNode components = doc.get("components");
        assertThat(components.get("schemas").propertyNames()).contains("ErrorsBody", "ErrorItem", "ProblemDetail");
        assertThat(components.get("headers").propertyNames()).contains("RetryAfter", "ETag", "XDatumRemovedLocales", "XPageCount");
        assertThat(components.get("parameters").propertyNames()).contains("IfMatch");
        assertThat(components.get("responses").propertyNames())
            .contains("BadRequest", "PayloadTooLarge", "UnsupportedMediaType", "Unprocessable", "TooManyRequests", "Unavailable", "InternalError");
        assertThat(components.at("/responses/Unavailable/headers/Retry-After/$ref").asString()).isEqualTo("#/components/headers/RetryAfter");
        assertThat(components.at("/responses/Unavailable/content/application~1json/schema/$ref").asString())
            .isEqualTo("#/components/schemas/ErrorsBody");
    }

    @Test
    void everyOperationGetsTheCommonErrorsAndSwitchedOffRoutesAreHidden() throws Exception {
        JsonNode doc = get("/v3/api-docs/datum-test");
        JsonNode paths = doc.get("paths");
        assertThat(paths.propertyNames()).contains("/test/echo").doesNotContain("/test/hidden/x");
        JsonNode echo = paths.get("/test/echo").get("post").get("responses");
        assertThat(echo.propertyNames()).contains("200", "413", "415", "429", "500", "503");
        // The application's own routes are not in Datum's group and never get Datum's responses.
        assertThat(paths.propertyNames()).doesNotContain("/app/boom");
    }
}
