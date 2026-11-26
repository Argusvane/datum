package com.argusvane.datum.starter.test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.core.env.Environment;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.assertj.MockMvcTester;
import org.springframework.test.web.servlet.client.RestTestClient;

/**
 * The helpers on the API base the application configured: with {@code datum.web.api.path} moved,
 * a hard-coded {@code /api} would miss every route, and the three Boot 4 clients (MockMvc, MockMvcTester, RestTestClient) all
 * follow the base through {@code of(client, environment)}.
 */
@SpringBootTest(classes = ConfiguredBaseHelperTest.App.class, properties = {"spring.main.web-application-type=servlet",
    "datum.web.api.path=/forms-api", "datum.web.api.endpoints.definition=true", "datum.web.api.endpoints.submissions=true"})
@AutoConfigureMockMvc
@AutoConfigureDatum(testForms = true)
class ConfiguredBaseHelperTest {

    @SpringBootApplication
    static class App {
    }

    @Autowired
    MockMvc mvc;

    @Autowired
    MockMvcTester tester;

    @Autowired
    Environment environment;

    @Test
    void theBaseIsReadFromTheEnvironment() {
        assertThat(DatumApiBase.of(environment)).isEqualTo("/forms-api");
        assertThat(DatumApiBase.of(new org.springframework.mock.env.MockEnvironment())).isEqualTo("/api");
        assertThat(DatumApiBase.of(new org.springframework.mock.env.MockEnvironment().withProperty("datum.web.api.path", "/v1/"))).isEqualTo("/v1");
    }

    @Test
    void mockMvcFollowsTheBase() throws Exception {
        DatumMockMvc datum = DatumMockMvc.of(mvc, environment);
        datum.definition("contact").andExpect(status().isOk()).andExpect(jsonPath("$.id").value("contact"));
        datum.submit(DatumTestForms.contactEnvelope("Ada", "Toronto")).andExpect(status().isOk());
        // The default literal misses: that is what the configured base fixes.
        new DatumMockMvc(mvc).definition("contact").andExpect(status().isNotFound());
    }

    @Test
    void mockMvcTesterFollowsTheBase() {
        DatumMockMvcTester datum = DatumMockMvcTester.of(tester, environment);
        assertThat(datum.api()).isEqualTo("/forms-api");
        assertThat(datum.definition("contact")).hasStatusOk().bodyJson().extractingPath("$.id").isEqualTo("contact");
        assertThat(datum.submit(DatumTestForms.contactEnvelope("Ada", "Toronto"))).hasStatusOk();
        assertThat(datum.definition("nothing-here")).hasStatus(404);
    }

    @Test
    void restTestClientFollowsTheBase() {
        DatumRestTestClient datum = DatumRestTestClient.of(RestTestClient.bindTo(mvc).build(), environment);
        datum.definition("contact").expectStatus().isOk().expectBody().jsonPath("$.id").isEqualTo("contact");
        datum.submit(DatumTestForms.contactEnvelope("Ada", "Toronto")).expectStatus().isOk();
        datum.definition("nothing-here").expectStatus().isNotFound();
    }
}
