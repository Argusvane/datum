package com.argusvane.datum.starter.test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;

/**
 * {@link AutoConfigureDatum} and the MockMvc helper on a Servlet application: no engine, the fixture forms served,
 * a submission accepted by the fake, and springdoc's group document naming the enabled routes.
 */
@SpringBootTest(classes = MockMvcHelperTest.App.class, properties = {"spring.main.web-application-type=servlet",
    // Every route is off until switched on.
    "datum.web.api.endpoints.definition=true", "datum.web.api.endpoints.submissions=true", "datum.web.api.endpoints.validate=true"})
@AutoConfigureMockMvc
@AutoConfigureDatum(testForms = true)
class MockMvcHelperTest {

    @SpringBootApplication
    static class App {
    }

    @Autowired
    MockMvc mvc;

    @Autowired
    FakeGuestRuntime runtime;

    @Test
    void theFixtureFormsAreServed() throws Exception {
        DatumMockMvc datum = new DatumMockMvc(mvc);
        datum.definition("contact").andExpect(status().isOk()).andExpect(jsonPath("$.id").value("contact"));
        datum.definition("nothing-here").andExpect(status().isNotFound());
    }

    @Test
    void theSecretRulesAreAbsentFromThePublicCopy() throws Exception {
        String body = new DatumMockMvc(mvc).definition("secret").andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        assertThat(body).doesNotContain("server-secret");
        assertThat(runtime.count("public")).isPositive();
    }

    @Test
    void aSubmissionIsAcceptedByTheFakeKernel() throws Exception {
        new DatumMockMvc(mvc).submit(DatumTestForms.contactEnvelope("Ada", "Toronto")).andExpect(status().isOk());
        assertThat(runtime.contexts()).isNotEmpty();
    }

    @Test
    void theGroupDocumentListsTheEnabledRoutes() throws Exception {
        DatumMockMvc datum = new DatumMockMvc(mvc);
        assertThat(datum.apiDocPaths("forms")).contains("/api/forms/{key}/definition").doesNotContain("/api/forms");
        assertThat(datum.apiDocOperations("submissions")).contains("POST /api/submissions", "POST /api/submissions/validate")
            .doesNotContain("POST /api/submissions/test");
    }
}
