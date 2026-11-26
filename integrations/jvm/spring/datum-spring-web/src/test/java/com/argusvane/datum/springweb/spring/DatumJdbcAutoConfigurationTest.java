package com.argusvane.datum.springweb.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.springweb.autoconfigure.DatumJdbcAutoConfiguration;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.sql.init.DatabaseInitializationMode;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** {@code datum.jdbc.initialize-schema} reaches the one initializer the stores ask. */
class DatumJdbcAutoConfigurationTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(DatumJdbcAutoConfiguration.class));

    @Test
    void theDefaultIsEmbedded() {
        runner.run(context -> assertThat(context.getBean(JdbcSchemaInitializer.class).mode()).isEqualTo(DatabaseInitializationMode.EMBEDDED));
    }

    @Test
    void theModeBindsRelaxed() {
        runner.withPropertyValues("datum.jdbc.initialize-schema=never")
            .run(context -> assertThat(context.getBean(JdbcSchemaInitializer.class).mode()).isEqualTo(DatabaseInitializationMode.NEVER));
        runner.withPropertyValues("datum.jdbc.initialize-schema=ALWAYS")
            .run(context -> assertThat(context.getBean(JdbcSchemaInitializer.class).mode()).isEqualTo(DatabaseInitializationMode.ALWAYS));
    }

    @Test
    void aWordThatIsNoModeStopsTheStartInBootsBinder() {
        runner.withPropertyValues("datum.jdbc.initialize-schema=sometimes").run(context -> {
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure()).hasStackTraceContaining("datum.jdbc.initialize-schema");
        });
    }

    @Test
    void theSwitchTurnsItOff() {
        runner.withPropertyValues("datum.enabled=false").run(context -> assertThat(context).doesNotHaveBean(JdbcSchemaInitializer.class));
    }

    @Test
    void anApplicationsOwnInitializerReplacesIt() {
        runner.withUserConfiguration(Own.class)
            .run(context -> assertThat(context.getBean(JdbcSchemaInitializer.class).mode()).isEqualTo(DatabaseInitializationMode.ALWAYS));
    }

    @Configuration(proxyBeanMethods = false)
    static class Own {
        @Bean
        JdbcSchemaInitializer mine() {
            return new JdbcSchemaInitializer(DatabaseInitializationMode.ALWAYS);
        }
    }
}
