package com.argusvane.datum.timestamp.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.DatumStartupCheck;
import com.argusvane.datum.springweb.autoconfigure.DatumJdbcAutoConfiguration;
import com.argusvane.datum.springweb.spring.DatumDataSource;
import com.argusvane.datum.timestamp.InMemoryTsaLog;
import com.argusvane.datum.timestamp.TimestampAuthority;
import com.argusvane.datum.timestamp.TsaSerialAllocator;
import java.time.Clock;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/**
 * The timestamp stores' share of the persistence settings. The module's real V300 script makes its tables in an
 * embedded database, the data source marked {@code @DatumDataSource} is the one the three stores use, and the
 * in-memory WARN is written whenever an in-memory allocator is among the allocators.
 */
class TsaJdbcSchemaWiringTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(DatumJdbcAutoConfiguration.class, DatumTimestampAutoConfiguration.class))
        .withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true", "datum.tsa.access=open");

    private static DriverManagerDataSource memory(String name) {
        return new DriverManagerDataSource("jdbc:h2:mem:" + name + "-" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1", "sa", "");
    }

    private static int tables(DataSource dataSource) {
        return new JdbcTemplate(dataSource).queryForObject(
            "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME IN ('DATUM_TSA_LOG', 'DATUM_TSA_CLIENT')", Integer.class);
    }

    @Test
    void anEmbeddedDatabaseGetsTheTsaTablesAndTheSerialsComeFromThem() {
        DriverManagerDataSource source = memory("embedded");
        runner.withBean("only", DataSource.class, () -> source).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(TsaSerialAllocator.class)).isInstanceOf(JdbcTsaSerialAllocator.class);
            assertThat(tables(source)).isEqualTo(2);
            assertThat(context.getBean(TimestampAuthority.class).stamp("x".getBytes(), "sealing")).isNotEmpty();
            assertThat(context.getBean(com.argusvane.datum.timestamp.TsaLog.class).count()).isEqualTo(1);
        });
    }

    @Test
    void neverLeavesTheTablesToTheApplication() {
        DriverManagerDataSource source = memory("never");
        runner.withBean("only", DataSource.class, () -> source).withPropertyValues("datum.jdbc.initialize-schema=never").run(context -> {
            assertThat(tables(source)).isZero();
        });
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
    void theMarkedDataSourceIsTheOneTheStoresUse() {
        runner.withUserConfiguration(TwoWithAMarked.class).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(TsaSerialAllocator.class)).isInstanceOf(JdbcTsaSerialAllocator.class);
            assertThat(tables(TwoWithAMarked.DATUM)).isEqualTo(2);
            assertThat(tables(TwoWithAMarked.APPLICATION)).isZero();
        });
    }

    @Test
    void theInMemoryWarnIsWrittenWithTwoAllocatorsToo() {
        DefaultListableBeanFactory beans = new DefaultListableBeanFactory();
        beans.registerSingleton("memory", new InMemoryTsaLog(Clock.systemUTC()));
        beans.registerSingleton("mine", (TsaSerialAllocator) entry -> 41);
        DatumStartupCheck check = new DatumTimestampAutoConfiguration().datumTsaSerialsStartupCheck(beans.getBeanProvider(TsaSerialAllocator.class));
        assertThat(check.check()).hasSize(1);

        DefaultListableBeanFactory only = new DefaultListableBeanFactory();
        only.registerSingleton("mine", (TsaSerialAllocator) entry -> 41);
        assertThat(new DatumTimestampAutoConfiguration().datumTsaSerialsStartupCheck(only.getBeanProvider(TsaSerialAllocator.class)).check()).isEmpty();
    }
}
