package com.argusvane.datum.ui.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.forms.spring.DatumFormsAutoConfiguration;
import com.argusvane.datum.forms.translation.TranslationCatalogStore;
import com.argusvane.datum.springweb.autoconfigure.DatumSecurityAutoConfiguration;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import com.argusvane.datum.ui.builder.BuilderApi;
import com.argusvane.datum.ui.builder.BuilderService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/**
 * Two start-up conventions. The in-memory stores' WARNs are written by the
 * start-up check runner once the beans exist (not by a store's constructor or a bean body), and the builder says its
 * translations are lost on a restart when the store is the in-memory one. The builder's routes are built over the
 * {@code BuilderService} bean; a context that left {@code DatumBuilderServiceAutoConfiguration} out stops at the missing
 * bean instead of serving routes over a hidden copy of the service.
 */
@ExtendWith(OutputCaptureExtension.class)
class BuilderStartupNoticesTest {

    private final WebApplicationContextRunner runner = new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumSecurityAutoConfiguration.class,
            DatumFormsAutoConfiguration.class, DatumUiAutoConfiguration.class, DatumBuilderServiceAutoConfiguration.class,
            DatumBuilderAutoConfiguration.class))
        .withPropertyValues("datum.builder.enabled=true");

    @Test
    void theInMemoryTranslationAndSnapshotStoresAreWarnedAboutInTheStartupReport(CapturedOutput output) {
        runner.run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(output).contains("the translation catalogs it saves are kept in memory")
                .contains("Datum keeps form definition snapshots in memory");
        });
    }

    @Test
    void anApplicationsTranslationStoreSilencesTheWarn(CapturedOutput output) {
        TranslationCatalogStore mine = org.mockito.Mockito.mock(TranslationCatalogStore.class);
        runner.withBean(TranslationCatalogStore.class, () -> mine).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(output).doesNotContain("the translation catalogs it saves are kept in memory");
        });
    }

    @Test
    void theBuilderRoutesRideTheBuilderServiceBeanAndThereIsNoHiddenCopy() {
        runner.run(context -> {
            assertThat(context).hasSingleBean(BuilderService.class).hasSingleBean(BuilderApi.class);
        });
        new WebApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumSecurityAutoConfiguration.class,
                DatumFormsAutoConfiguration.class, DatumUiAutoConfiguration.class, DatumBuilderAutoConfiguration.class))
            .withPropertyValues("datum.builder.enabled=true")
            .run(context -> assertThat(context).hasFailed().getFailure().hasStackTraceContaining("BuilderService"));
    }
}
