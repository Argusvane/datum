package com.argusvane.datum.submissions;

import com.argusvane.datum.sandbox.runtime.TestRuntime;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.sandbox.wasi.EngineSelectionException;
import com.argusvane.datum.sandbox.wasi.EngineSettings;
import com.argusvane.datum.forms.spring.DatumFormsAutoConfiguration;
import com.argusvane.datum.springweb.autoconfigure.DatumJdbcAutoConfiguration;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import com.argusvane.datum.springweb.spring.DatumDataSource;
import com.argusvane.datum.submissions.idempotency.InMemorySubmissionIdempotencyStore;
import com.argusvane.datum.submissions.spi.SubmissionIdempotencyStore;
import com.argusvane.datum.sandbox.spring.DatumSandboxProperties;
import com.argusvane.datum.sandbox.spring.DatumSandboxAutoConfiguration;
import com.argusvane.datum.submissions.spring.DatumSubmissionsAutoConfiguration;
import com.argusvane.datum.submissions.spring.JdbcSubmissionIdempotencyStore;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.BeanFactory;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.diagnostics.FailureAnalysis;
import org.springframework.boot.diagnostics.FailureAnalyzer;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.io.support.SpringFactoriesLoader;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/**
 * The submissions binding's share of the persistence settings (the data source qualifier and the schema), the start-up experience
 * (a misnamed engine reads as one Description and Action) and the engine settings bean.
 */
class SubmissionsStartupExperienceTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumJdbcAutoConfiguration.class,
            DatumFormsAutoConfiguration.class, DatumSandboxAutoConfiguration.class, DatumSubmissionsAutoConfiguration.class))
        .withPropertyValues("datum.forms.locations=classpath:/datum-test-forms/*.json", "datum.runtime.warm-up-runs=1");

    @Configuration(proxyBeanMethods = false)
    static class WithRuntime {
        @Bean
        TestRuntime testRuntime() {
            return new TestRuntime();
        }
    }

    private static DriverManagerDataSource memory(String name) {
        return new DriverManagerDataSource("jdbc:h2:mem:" + name + "-" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1", "sa", "");
    }

    private static int tables(DataSource dataSource) {
        return new JdbcTemplate(dataSource).queryForObject(
            "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'DATUM_SUBMISSION_DIGEST'", Integer.class);
    }

    // ------------------------------------------------------------------------------------------- the digest table

    @Test
    void anEmbeddedDatabaseGetsTheDigestTableFromTheModulesScriptAndTheJdbcStoreIsUsed() {
        DriverManagerDataSource source = memory("embedded");
        runner.withUserConfiguration(WithRuntime.class).withBean("only", DataSource.class, () -> source).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(SubmissionIdempotencyStore.class)).isInstanceOf(JdbcSubmissionIdempotencyStore.class);
            assertThat(tables(source)).isEqualTo(1);
        });
    }

    @Test
    void neverLeavesTheTableToTheApplicationAndTheStoreFallsBackToMemory() {
        DriverManagerDataSource source = memory("never");
        runner.withUserConfiguration(WithRuntime.class).withBean("only", DataSource.class, () -> source)
            .withPropertyValues("datum.jdbc.initialize-schema=never").run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(SubmissionIdempotencyStore.class)).isInstanceOf(InMemorySubmissionIdempotencyStore.class);
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
    void theMarkedDataSourceIsTheOneTheIdempotencyStoreUses() {
        runner.withUserConfiguration(WithRuntime.class, TwoWithAMarked.class).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(SubmissionIdempotencyStore.class)).isInstanceOf(JdbcSubmissionIdempotencyStore.class);
            assertThat(tables(TwoWithAMarked.DATUM)).isEqualTo(1);
            assertThat(tables(TwoWithAMarked.APPLICATION)).isZero();
        });
    }

    // ------------------------------------------------------------------------------------------- failure analyzers

    private static List<FailureAnalyzer> analyzers() {
        SpringFactoriesLoader.ArgumentResolver arguments = SpringFactoriesLoader.ArgumentResolver.of(BeanFactory.class, new DefaultListableBeanFactory())
            .and(Environment.class, new StandardEnvironment());
        return SpringFactoriesLoader.forDefaultResourceLocation(SubmissionsStartupExperienceTest.class.getClassLoader())
            .load(FailureAnalyzer.class, arguments);
    }

    @Test
    void aMisnamedEngineStopsTheStartWithTheTypedExceptionAndReadsAsADescriptionAndAnAction() {
        runner.withPropertyValues("datum.runtime.engine=endvie").run(context -> {
            assertThat(context).hasFailed();
            Throwable failure = context.getStartupFailure();
            assertThat(failure).rootCause().isInstanceOf(EngineSelectionException.class);
            FailureAnalysis analysis = analyzers().stream().map(analyzer -> analyzer.analyze(failure)).filter(java.util.Objects::nonNull)
                .findFirst().orElse(null);
            assertThat(analysis).as("an analyzer answers").isNotNull();
            assertThat(analysis.getDescription()).contains("datum.runtime.engine is \"endvie\"").contains("engines found: endive");
            assertThat(analysis.getAction()).contains("datum.runtime.engine").contains("GuestRuntime bean");
        });
    }

    /** The bytecode refusal reads as one Description (the engine's reason in it) and one Action (the two fixes). */
    @Test
    void anEngineOnBytecodeStopsTheStartAndReadsAsADescriptionAndAnAction() {
        TestRuntime bytecode = new TestRuntime();
        bytecode.mode = "bytecode";
        runner.withBean(TestRuntime.class, () -> bytecode).run(context -> {
            assertThat(context).hasFailed();
            Throwable failure = context.getStartupFailure();
            assertThat(failure).rootCause().isInstanceOf(com.argusvane.datum.sandbox.runtime.EngineBytecodeException.class);
            FailureAnalysis analysis = analyzers().stream().map(analyzer -> analyzer.analyze(failure)).filter(java.util.Objects::nonNull)
                .findFirst().orElse(null);
            assertThat(analysis).as("an analyzer answers").isNotNull();
            assertThat(analysis.getDescription()).contains("would run the programs as JVM bytecode")
                .contains("datum.runtime.allow-bytecode is false").contains(bytecode.engineInfo().notes());
            assertThat(analysis.getAction()).contains("native code").contains("datum.runtime.allow-bytecode=true");
        });
    }

    // ------------------------------------------------------------------------------------------- engine settings

    @Test
    void theEngineSettingsAreABeanFromTheDefaultsAndTheProperties() {
        runner.withUserConfiguration(WithRuntime.class).run(context -> {
            EngineSettings settings = context.getBean(EngineSettings.class);
            assertThat(settings).isEqualTo(EngineSettings.defaults());
        });
        runner.withUserConfiguration(WithRuntime.class).withPropertyValues("datum.runtime.stop-grace=2s", "datum.runtime.max-strays=7").run(context -> {
            assertThat(context.getBean(EngineSettings.class)).isEqualTo(new EngineSettings(Duration.ofSeconds(2), 7));
            assertThat(context.getBean(com.argusvane.datum.sandbox.runtime.SandboxSettings.class).engine().maxStrays()).isEqualTo(7);
        });
    }

    @Test
    void anApplicationsEngineSettingsBeanReplacesThem() {
        EngineSettings mine = new EngineSettings(Duration.ofMillis(250), 3);
        runner.withUserConfiguration(WithRuntime.class).withBean(EngineSettings.class, () -> mine)
            .run(context -> assertThat(context.getBean(EngineSettings.class)).isSameAs(mine));
    }

    @Test
    void aNegativeGraceOrStrayCountStopsTheStartNamingTheProperty() {
        runner.withUserConfiguration(WithRuntime.class).withPropertyValues("datum.runtime.stop-grace=-1s").run(context -> {
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure()).rootCause().isInstanceOfSatisfying(DatumConfigurationException.class,
                refusal -> assertThat(refusal.property()).isEqualTo("datum.runtime.stop-grace"));
        });
        DatumSandboxProperties properties = new DatumSandboxProperties();
        properties.setMaxStrays(-1);
        assertThatThrownBy(properties::toSettings).isInstanceOfSatisfying(DatumConfigurationException.class,
            refusal -> assertThat(refusal.property()).isEqualTo("datum.runtime.max-strays"));
    }
}
