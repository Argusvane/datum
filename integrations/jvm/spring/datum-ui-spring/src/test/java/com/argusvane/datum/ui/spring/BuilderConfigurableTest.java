package com.argusvane.datum.ui.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.forms.spring.DatumFormsAutoConfiguration;
import com.argusvane.datum.springweb.autoconfigure.DatumSecurityAutoConfiguration;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import com.argusvane.datum.ui.UiSettings;
import com.argusvane.datum.ui.builder.BuilderApi;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.test.util.ReflectionTestUtils;

/** What is configurable on the builder: the Clock, the upper bound of the size cap and the beans an application replaces. */
class BuilderConfigurableTest {

    private final WebApplicationContextRunner runner = new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumSecurityAutoConfiguration.class,
            DatumFormsAutoConfiguration.class, DatumUiAutoConfiguration.class, DatumBuilderServiceAutoConfiguration.class, DatumBuilderAutoConfiguration.class))
        .withPropertyValues("datum.builder.enabled=true");

    @Test
    void theApplicationsClockReachesTheBuilder() {
        Clock fixed = Clock.fixed(Instant.parse("2026-03-04T05:06:07Z"), ZoneOffset.UTC);
        runner.withBean(Clock.class, () -> fixed).run(context -> {
            assertThat(context).hasNotFailed();
            // The clock is the writes': the BuilderService under the routes.
            assertThat(ReflectionTestUtils.getField(context.getBean(BuilderApi.class).service(), "clock")).isSameAs(fixed);
        });
        runner.run(context -> assertThat(ReflectionTestUtils.getField(context.getBean(BuilderApi.class).service(), "clock")).isInstanceOf(Clock.class));
    }

    @Test
    void theSizeCapIsAtMostSixtyFourMebibytes() {
        runner.withPropertyValues("datum.builder.max-definition-size=64MB").run(context ->
            assertThat(context.getBean(BuilderApi.class).maxDefinitionBytes()).isEqualTo(64L * 1024 * 1024));
        for (String bad : new String[] {"datum.builder.max-definition-size=65MB", "datum.builder.max-definition-size=0B"}) {
            runner.withPropertyValues(bad).run(context -> {
                assertThat(context).as(bad).hasFailed();
                assertThat(context.getStartupFailure()).as(bad).hasStackTraceContaining("datum.builder.max-definition-size");
            });
        }
    }

    @Test
    void anApplicationsSettingsAndApiBeansReplaceTheBindings() {
        UiSettings mine = new UiSettings(true, 4096);
        runner.withBean(UiSettings.class, () -> mine).withPropertyValues("datum.builder.max-definition-size=2MB").run(context -> {
            assertThat(context).hasSingleBean(UiSettings.class);
            assertThat(context.getBean(UiSettings.class)).isSameAs(mine);
        });
        runner.withUserConfiguration(Mine.class).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBeansOfType(BuilderApi.class)).containsOnlyKeys("applicationApi");
            assertThat(context.getBean(BuilderApi.class).maxDefinitionBytes()).isEqualTo(2048);
        });
    }

    /**
     * The builder's routes follow the {@code WebSettings} bean, as the forms and submissions routes and the
     * builder's own WebFlux method rules do, so an application's settings bean with another API path moves the builder's
     * writes too (they do not read {@code datum.web.api.path} from the properties directly).
     */
    @Test
    void theBuildersRoutesFollowAnApplicationsWebSettingsBean() {
        com.argusvane.datum.web.WebSettings defaults = com.argusvane.datum.web.WebSettings.defaults();
        com.argusvane.datum.web.WebSettings mine = new com.argusvane.datum.web.WebSettings(defaults.enabled(),
            new com.argusvane.datum.web.WebSettings.Api("/v2", defaults.api().maxBodyBytes(), defaults.api().problemDetails(),
                defaults.api().endpoints(), defaults.api().busyRetryAfter()),
            defaults.assets(), defaults.csrf(), defaults.throttle(), defaults.openapi());
        runner.withBean(com.argusvane.datum.web.WebSettings.class, () -> mine).withPropertyValues("datum.web.api.path=/property-api")
            .run(context -> {
                assertThat(context).hasNotFailed();
                com.argusvane.datum.ui.builder.BuilderRoutes routes = context.getBean(com.argusvane.datum.ui.builder.BuilderRoutes.class);
                assertThat(routes.api()).isEqualTo("/v2");
                assertThat(routes.createPath()).isEqualTo("/v2/forms");
            });
    }

    @org.springframework.context.annotation.Configuration(proxyBeanMethods = false)
    static class Mine {

        @org.springframework.context.annotation.Bean
        BuilderApi applicationApi(com.argusvane.datum.forms.FormDefinitionRepository repository,
                                  com.argusvane.datum.forms.DefinitionService definitions,
                                  com.argusvane.datum.forms.translation.TranslationCatalogStore translations) {
            return new BuilderApi(repository, definitions, translations, java.util.List.of(), 2048, "/api", Clock.systemUTC());
        }
    }
}
