package com.argusvane.datum.submissions.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.submissions.receiver.SubmissionReceiver;
import com.argusvane.datum.sandbox.runtime.DatumSandbox;
import com.argusvane.datum.web.json.DatumJsonMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;

/** An application's {@code SubmissionsApi} bean replaces the binding's; the controllers use it. */
@SpringBootTest(classes = {SubmissionsMvcTestApp.class, MvcSubmissionsApiOverrideTest.Mine.class}, properties = {
    "spring.main.web-application-type=servlet",
    "datum.web.api.endpoints.submissions=true",
    "datum.forms.locations=classpath:/datum-test-forms/*.json",
    "datum.runtime.warm-up-runs=1"})
class MvcSubmissionsApiOverrideTest {

    @TestConfiguration(proxyBeanMethods = false)
    static class Mine {

        @Bean
        SubmissionsApi applicationApi(SubmissionReceiver receiver, DatumSandbox runtime, DefinitionService definitions, DatumJsonMapper json) {
            return new SubmissionsApi(receiver, runtime::sandbox, definitions, json, 2048);
        }
    }

    @Autowired
    ApplicationContext context;

    @Test
    void onlyTheApplicationsApiIsInTheContext() {
        assertThat(context.getBeansOfType(SubmissionsApi.class)).containsOnlyKeys("applicationApi");
        assertThat(context.getBean(SubmissionsApi.class).maxBodyBytes()).isEqualTo(2048);
    }
}
