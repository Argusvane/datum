package com.argusvane.datum.springweb.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.sandbox.protocol.SandboxException;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import com.argusvane.datum.web.WebSettings;
import com.argusvane.datum.web.error.ErrorMapper;
import java.time.Duration;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/**
 * A replaced {@code WebSettings} bean is the one the binding reads (the error mapper takes its busy
 * Retry-After from it, not from the properties), and the property reaches the same place on the wire.
 */
class WebSettingsOverrideTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class));

    private static String retryAfter(ErrorMapper mapper) {
        return mapper.map(new SandboxException(SandboxException.Reason.BUSY, "all slots taken")).headers().get("Retry-After");
    }

    @Test
    void anApplicationsWebSettingsBeanIsTheOneTheErrorMapperReads() {
        WebSettings mine = new WebSettings(true,
            new WebSettings.Api("/datum", 1024, false, Map.of(), Duration.ofSeconds(9)),
            WebSettings.Assets.defaults(), WebSettings.Csrf.defaults(), WebSettings.Throttle.defaults(), WebSettings.OpenApi.defaults());
        runner.withBean(WebSettings.class, () -> mine).withPropertyValues("datum.web.api.busy-retry-after=30s").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(WebSettings.class)).isSameAs(mine);
            assertThat(retryAfter(context.getBean(ErrorMapper.class))).as("the bean, not the property").isEqualTo("9");
        });
    }

    @Test
    void theBusyRetryAfterPropertyChangesTheHeader() {
        runner.run(context -> assertThat(retryAfter(context.getBean(ErrorMapper.class))).isEqualTo("5"));
        runner.withPropertyValues("datum.web.api.busy-retry-after=9s")
            .run(context -> assertThat(retryAfter(context.getBean(ErrorMapper.class))).isEqualTo("9"));
    }
}
