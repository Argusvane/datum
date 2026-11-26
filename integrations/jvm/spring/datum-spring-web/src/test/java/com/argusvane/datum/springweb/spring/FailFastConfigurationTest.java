package com.argusvane.datum.springweb.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/**
 * Configuration fails fast on a value that cannot work, as Spring Boot does, naming the property. A
 * value the framework cannot bind at all (a word that is no number or duration) fails in Boot's own binder; the ones
 * that bind but cannot work are refused when the settings are built.
 */
class FailFastConfigurationTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class));

    @Test
    void aValueThatCannotWorkStopsTheStartNamingTheProperty() {
        for (String[] bad : new String[][] {
            {"datum.web.api.max-body-size=0B", "datum.web.api.max-body-size"},
            {"datum.web.api.max-body-size=-1B", "datum.web.api.max-body-size"},
            {"datum.web.assets.cache-period=-1d", "datum.web.assets.cache-period"},
            {"datum.web.api.max-body-size=lots", "datum.web.api.max-body-size"},
            {"datum.web.assets.cache-period=forever", "datum.web.assets.cache-period"}}) {
            runner.withPropertyValues(bad[0]).run(context -> {
                assertThat(context).as(bad[0]).hasFailed();
                assertThat(context.getStartupFailure()).as(bad[0]).hasStackTraceContaining(bad[1]);
            });
        }
    }

    @Test
    void goodValuesStart() {
        runner.withPropertyValues("datum.web.api.max-body-size=2MB", "datum.web.assets.cache-period=0s").run(context -> assertThat(context).hasNotFailed());
    }
}
