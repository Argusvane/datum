package com.argusvane.datum.ui.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.forms.spring.DatumFormsAutoConfiguration;
import com.argusvane.datum.springweb.autoconfigure.DatumSecurityAutoConfiguration;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import com.argusvane.datum.ui.builder.BuilderApi;
import com.argusvane.datum.ui.builder.BuilderService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;

/**
 * The builder's {@link BuilderService} bean: there wherever forms are authored, a web application or not, the
 * routes' {@link BuilderApi} built over it, and absent while the builder is off.
 */
class BuilderServiceBeanTest {

    private static final AutoConfigurations CONFIGURATIONS = AutoConfigurations.of(DatumWebAutoConfiguration.class,
        DatumSecurityAutoConfiguration.class, DatumFormsAutoConfiguration.class, DatumUiAutoConfiguration.class,
        DatumBuilderServiceAutoConfiguration.class, DatumBuilderAutoConfiguration.class);

    @Test
    void anApplicationWithoutAWebServerGetsTheServiceAndNoRoutes() {
        new ApplicationContextRunner().withConfiguration(CONFIGURATIONS).withPropertyValues("datum.builder.enabled=true").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).hasSingleBean(BuilderService.class);
            assertThat(context).doesNotHaveBean(BuilderApi.class);
        });
    }

    @Test
    void theRoutesAreBuiltOverTheServiceBean() {
        new WebApplicationContextRunner().withConfiguration(CONFIGURATIONS).withPropertyValues("datum.builder.enabled=true").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(BuilderApi.class).service()).isSameAs(context.getBean(BuilderService.class));
        });
    }

    /** The service holds every caller to the routes' cap, {@code datum.builder.max-definition-size}. */
    @Test
    void theServiceHasTheRoutesCapWithOrWithoutAWebServer() {
        new ApplicationContextRunner().withConfiguration(CONFIGURATIONS)
            .withPropertyValues("datum.builder.enabled=true", "datum.builder.max-definition-size=256KB").run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(BuilderService.class).maxDefinitionBytes()).isEqualTo(256 * 1024);
            });
        new WebApplicationContextRunner().withConfiguration(CONFIGURATIONS)
            .withPropertyValues("datum.builder.enabled=true", "datum.builder.max-definition-size=256KB").run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(BuilderApi.class).maxDefinitionBytes())
                    .isEqualTo(context.getBean(BuilderService.class).maxDefinitionBytes()).isEqualTo(256 * 1024);
            });
    }

    @Test
    void anApplicationsServiceIsTheOneTheRoutesUse() {
        new WebApplicationContextRunner().withConfiguration(CONFIGURATIONS).withPropertyValues("datum.builder.enabled=true")
            .withUserConfiguration(OwnService.class).run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBeansOfType(BuilderService.class)).containsOnlyKeys("ownBuilderService");
                assertThat(context.getBean(BuilderApi.class).service()).isSameAs(context.getBean("ownBuilderService"));
            });
    }

    /** An application's own service: the binding's backs off and the routes are built over this one. */
    @org.springframework.context.annotation.Configuration(proxyBeanMethods = false)
    static class OwnService {

        @org.springframework.context.annotation.Bean
        BuilderService ownBuilderService(com.argusvane.datum.forms.FormDefinitionRepository repository,
                                         com.argusvane.datum.forms.DefinitionService definitions,
                                         com.argusvane.datum.forms.translation.TranslationCatalogStore translations) {
            return BuilderService.builder().repository(repository).definitions(definitions).translations(translations).types(java.util.List.of()).clock(java.time.Clock.systemUTC()).build();
        }
    }

    @Test
    void theBuilderOffMeansNoService() {
        new ApplicationContextRunner().withConfiguration(CONFIGURATIONS).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).doesNotHaveBean(BuilderService.class);
        });
    }
}
