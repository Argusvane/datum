package com.argusvane.datum.ui.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.forms.spring.DatumFormsAutoConfiguration;
import com.argusvane.datum.springweb.autoconfigure.DatumSecurityAutoConfiguration;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import com.argusvane.datum.ui.builder.BuilderApi;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.security.web.DefaultSecurityFilterChain;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.util.matcher.AnyRequestMatcher;

/**
 * The builder's start-up lines (framework-first): who may build is the application's security, so
 * with the builder on the start says it is on (datum-ui's BuilderStartupChecks), and datum-spring-web WARNs that the
 * builder's routes are open when the application declares no security filter chain; a chain silences the WARN. These
 * run the Spring context: the lines reach the log through the start-up check runner.
 */
@ExtendWith(OutputCaptureExtension.class)
class BuilderSecurityWarningTest {

    final WebApplicationContextRunner runner = new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumSecurityAutoConfiguration.class,
            DatumFormsAutoConfiguration.class, DatumUiAutoConfiguration.class, DatumBuilderServiceAutoConfiguration.class, DatumBuilderAutoConfiguration.class))
        .withPropertyValues("datum.builder.enabled=true");

    @Test
    void theBuilderWithoutASecurityChainIsWarnedAbout(CapturedOutput output) {
        runner.run(context -> {
            assertThat(context).hasSingleBean(BuilderApi.class);
            assertThat(output).contains("The Datum builder is enabled")
                .contains("these routes are open: add spring-boot-starter-security and secure DatumRequestMatchers")
                .contains("builderWrites()");
        });
    }

    @Test
    void aSecurityChainSilencesTheWarn(CapturedOutput output) {
        runner.withBean("chain", SecurityFilterChain.class, () -> new DefaultSecurityFilterChain(AnyRequestMatcher.INSTANCE)).run(context -> {
            assertThat(context).hasSingleBean(BuilderApi.class);
            assertThat(output).contains("The Datum builder is enabled").doesNotContain("these routes are open");
        });
    }

    @Test
    void theBuilderOffMeansNoWriteEndpointsAndNoWarn(CapturedOutput output) {
        new WebApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumSecurityAutoConfiguration.class,
                DatumFormsAutoConfiguration.class, DatumUiAutoConfiguration.class, DatumBuilderServiceAutoConfiguration.class, DatumBuilderAutoConfiguration.class))
            .run(context -> {
                assertThat(context).doesNotHaveBean(BuilderApi.class);
                assertThat(output).doesNotContain("these routes are open").doesNotContain("The Datum builder is enabled");
            });
    }

    /** A definition cap that cannot work stops the start naming the property, rather than reading as the default. */
    @Test
    void aDefinitionSizeBelowOneByteStopsTheStartNamingTheProperty() {
        for (String size : new String[] {"0B", "-1B"}) {
            runner.withPropertyValues("datum.builder.max-definition-size=" + size).run(context -> {
                assertThat(context).as(size).hasFailed();
                assertThat(context.getStartupFailure()).as(size).hasStackTraceContaining("datum.builder.max-definition-size");
            });
        }
        runner.withPropertyValues("datum.builder.max-definition-size=2MB").run(context -> assertThat(context).hasNotFailed());
    }
}
