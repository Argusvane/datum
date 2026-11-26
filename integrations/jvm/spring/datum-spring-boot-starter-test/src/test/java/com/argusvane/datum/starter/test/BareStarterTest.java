package com.argusvane.datum.starter.test;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.DatumStartupCheck;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.ApplicationContext;
import org.springframework.http.HttpMethod;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;

/**
 * Every endpoint is off by default: a starter on the class path and not one {@code datum.*} route property
 * maps no Datum route. Every path the endpoint catalog lists answers 404 (the framework's own, nobody's refusal), and the
 * start logs the notice that says none is on and names the properties.
 */
@SpringBootTest(classes = BareStarterTest.App.class, properties = "spring.main.web-application-type=servlet")
@AutoConfigureMockMvc
@AutoConfigureDatum(testForms = true)
@ExtendWith(OutputCaptureExtension.class)
class BareStarterTest {

    @SpringBootApplication
    static class App {
    }

    @Autowired
    MockMvc mvc;

    @Autowired
    ApplicationContext context;

    @Test
    void noCataloguedRouteIsMapped(CapturedOutput output) throws Exception {
        for (DatumEndpointCatalog.Endpoint endpoint : DatumEndpointCatalog.endpoints()) {
            String path = endpoint.path(endpoint.base().defaultPath()).replaceAll("\\{[^}]+}", "x");
            int status = mvc.perform(MockMvcRequestBuilders.request(HttpMethod.valueOf(endpoint.method()), path)).andReturn().getResponse().getStatus();
            assertThat(status).as(endpoint.method() + " " + path + " (" + endpoint.switchKey() + ")").isEqualTo(404);
        }
        // The asset routes are endpoints too.
        assertThat(mvc.perform(MockMvcRequestBuilders.get("/datum/assets/host.json")).andReturn().getResponse().getStatus()).isEqualTo(404);
        assertThat(output.getAll()).contains("no Datum route is enabled");
    }

    /** The OpenAPI groups follow the switches: a bare application documents no Datum route. */
    @Test
    void theDocumentsListNoPaths() throws Exception {
        DatumMockMvc datum = new DatumMockMvc(mvc);
        for (String group : new String[] {"forms", "submissions", "pdf"}) {
            assertThat(datum.apiDocPaths(group)).as(group).isEmpty();
        }
    }

    @Test
    void theNoticeNamesTheSwitchesToSet() {
        var notices = context.getBean("datumEnabledRoutesNotice", DatumStartupCheck.class).check();
        assertThat(notices).hasSize(1);
        assertThat(notices.get(0).message()).contains("datum.web.api.endpoints.*", "datum.web.assets.enabled", "datum.builder.enabled",
            "datum.tsa.enabled", "datum.webauthn.enabled");
    }
}
