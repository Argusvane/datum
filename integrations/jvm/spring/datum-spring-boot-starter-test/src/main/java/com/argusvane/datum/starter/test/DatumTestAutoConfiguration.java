package com.argusvane.datum.starter.test;

import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;

/**
 * What {@link AutoConfigureDatum} adds, as an auto-configuration: bean conditions belong only in
 * auto-configurations, where they are evaluated after the application's own configurations whatever order the test
 * configurations load in, and where the condition report names this class. It is ordered before the sandbox binding, so
 * the {@code ConditionalOnMissingBean} of Datum's own Endive runtime sees the fake and backs off; an application's own
 * {@code GuestRuntime} bean still wins over both. The fake is declared by its own type so a test can autowire it.
 *
 * <p>Listed in {@code META-INF/spring/com.argusvane.datum.starter.test.AutoConfigureDatum.imports}, not in
 * {@code AutoConfiguration.imports}: only a test that asks for it gets it.
 */
@AutoConfiguration(beforeName = "com.argusvane.datum.sandbox.spring.DatumSandboxAutoConfiguration")
final class DatumTestAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean(GuestRuntime.class)
    FakeGuestRuntime datumFakeGuestRuntime() {
        return new FakeGuestRuntime();
    }
}
