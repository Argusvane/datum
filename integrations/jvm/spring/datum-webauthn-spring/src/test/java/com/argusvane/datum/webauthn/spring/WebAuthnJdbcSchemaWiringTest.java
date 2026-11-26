package com.argusvane.datum.webauthn.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.springweb.autoconfigure.DatumJdbcAutoConfiguration;
import com.argusvane.datum.springweb.spring.DatumDataSource;
import com.argusvane.datum.webauthn.ChallengeClaims;
import com.argusvane.datum.webauthn.PasskeyRepository;
import com.argusvane.datum.webauthn.PasskeyUseStore;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/**
 * The passkey stores' share of the persistence settings. The module's real V400 script makes its three tables in an
 * embedded database and the data source marked {@code @DatumDataSource} is the one all three stores use.
 */
class WebAuthnJdbcSchemaWiringTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(DatumJdbcAutoConfiguration.class, DatumWebAuthnAutoConfiguration.class))
        .withPropertyValues("datum.webauthn.enabled=true", "datum.webauthn.rp-id=example.org", "datum.webauthn.rp-name=Example",
            "datum.webauthn.origins=https://forms.example.org", "datum.webauthn.secret=a configured secret of at least 32 bytes!");

    private static DriverManagerDataSource memory(String name) {
        return new DriverManagerDataSource("jdbc:h2:mem:" + name + "-" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1", "sa", "");
    }

    private static int tables(DataSource dataSource) {
        return new JdbcTemplate(dataSource).queryForObject("SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME IN "
            + "('DATUM_PASSKEY', 'DATUM_PASSKEY_USE', 'DATUM_PASSKEY_CHALLENGE')", Integer.class);
    }

    @Test
    void anEmbeddedDatabaseGetsTheThreeTablesAndAllThreeStoresAreSql() {
        DriverManagerDataSource source = memory("embedded");
        runner.withBean("only", DataSource.class, () -> source).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(PasskeyRepository.class)).isInstanceOf(JdbcPasskeyRepository.class);
            assertThat(context.getBean(PasskeyUseStore.class)).isInstanceOf(JdbcPasskeyUseStore.class);
            assertThat(context.getBean(ChallengeClaims.class)).isInstanceOf(JdbcChallengeClaims.class);
            assertThat(tables(source)).isEqualTo(3);
        });
    }

    @Test
    void neverLeavesTheTablesToTheApplication() {
        DriverManagerDataSource source = memory("never");
        runner.withBean("only", DataSource.class, () -> source).withPropertyValues("datum.jdbc.initialize-schema=never")
            .run(context -> assertThat(tables(source)).isZero());
    }

    @Configuration(proxyBeanMethods = false)
    static class TwoWithAMarked {
        static final DriverManagerDataSource APPLICATION = memory("application");
        static final DriverManagerDataSource DATUM = memory("datum");

        @Bean
        @org.springframework.context.annotation.Primary
        DataSource application() {
            return APPLICATION;
        }

        @Bean
        @DatumDataSource
        DataSource forDatum() {
            return DATUM;
        }
    }

    @Test
    void theMarkedDataSourceIsTheOneAllThreeStoresUse() {
        runner.withUserConfiguration(TwoWithAMarked.class).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(PasskeyRepository.class)).isInstanceOf(JdbcPasskeyRepository.class);
            assertThat(tables(TwoWithAMarked.DATUM)).isEqualTo(3);
            assertThat(tables(TwoWithAMarked.APPLICATION)).isZero();
        });
    }
}
