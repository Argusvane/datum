package com.argusvane.datum.forms.web;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.FormDefinitionRepository;
import com.argusvane.datum.forms.datasource.DataSourceOptions;
import com.argusvane.datum.forms.translation.TranslationCatalogStore;
import com.argusvane.datum.web.json.DatumJsonMapper;
import com.argusvane.datum.web.monitoring.DatumCapabilities;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;

/** An application's {@code FormsApi} bean replaces the binding's and keeps the forms capability. */
@SpringBootTest(classes = {FormsMvcTestApp.class, MvcFormsApiOverrideTest.Mine.class}, properties = {
    "datum.web.api.endpoints.definition=true", "spring.main.web-application-type=servlet"})
class MvcFormsApiOverrideTest {

    @TestConfiguration(proxyBeanMethods = false)
    static class Mine {

        @Bean
        FormsApi applicationApi(DefinitionService definitions, FormDefinitionRepository repository, TranslationCatalogStore translations,
                                DataSourceOptions dataSources, DatumJsonMapper json) {
            return new FormsApi(definitions, repository, translations, dataSources, json, "private", "public");
        }
    }

    @Autowired
    ApplicationContext context;

    @Test
    void onlyTheApplicationsApiIsInTheContext() {
        assertThat(context.getBeansOfType(FormsApi.class)).containsOnlyKeys("applicationApi");
    }

    /**
     * The forms capability is a bean of its own, not a registration inside the replaced {@code FormsApi}
     * factory method, so the start-up notice, {@code info.datum} and {@code host.json} still list the definition routes.
     */
    @Test
    void theFormsCapabilityStaysWithTheApplicationsApi() {
        assertThat(context.getBean(DatumCapabilities.class).present()).contains("forms");
    }
}
