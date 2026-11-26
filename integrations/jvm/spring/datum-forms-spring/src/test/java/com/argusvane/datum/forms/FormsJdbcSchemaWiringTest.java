package com.argusvane.datum.forms;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.forms.snapshot.DefinitionSnapshotStore;
import com.argusvane.datum.forms.snapshot.InMemoryDefinitionSnapshotStore;
import com.argusvane.datum.forms.spring.DatumFormsAutoConfiguration;
import com.argusvane.datum.forms.spring.JdbcDefinitionSnapshotStore;
import com.argusvane.datum.springweb.autoconfigure.DatumJdbcAutoConfiguration;
import com.argusvane.datum.springweb.spring.DatumDataSource;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import tools.jackson.databind.node.ObjectNode;

/**
 * The snapshot store's persistence settings: the data source marked {@code @DatumDataSource} is the one it uses, and the
 * module's real script makes its table in an embedded database unless {@code datum.jdbc.initialize-schema} says otherwise.
 */
class FormsJdbcSchemaWiringTest {

    private static DriverManagerDataSource memory(String name) {
        // DB_CLOSE_DELAY keeps the in-memory database alive between the initializer's connection and the store's.
        return new DriverManagerDataSource("jdbc:h2:mem:" + name + "-" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1", "sa", "");
    }

    private static boolean hasTable(DataSource dataSource) {
        return new JdbcTemplate(dataSource).queryForObject(
            "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'DATUM_DEFINITION_SNAPSHOT'", Integer.class) > 0;
    }

    private static ObjectNode definition() {
        ObjectNode node = tools.jackson.databind.json.JsonMapper.builder().build().createObjectNode();
        node.put("id", "contact");
        return node;
    }

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(DatumJdbcAutoConfiguration.class, DatumFormsAutoConfiguration.class));

    @Configuration(proxyBeanMethods = false)
    static class Single {
        static final DriverManagerDataSource SOURCE = memory("single");

        @Bean
        DataSource only() {
            return SOURCE;
        }
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
    void anEmbeddedDatabaseGetsTheTableFromTheModulesOwnScriptAndTheStoreWorks() {
        runner.withUserConfiguration(Single.class).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(DefinitionSnapshotStore.class)).isInstanceOf(JdbcDefinitionSnapshotStore.class);
            assertThat(hasTable(Single.SOURCE)).isTrue();
            DefinitionSnapshotStore store = context.getBean(DefinitionSnapshotStore.class);
            store.record("contact", "a".repeat(64), definition());
            assertThat(store.find("contact", "a".repeat(64))).isPresent();
        });
    }

    @Test
    void neverLeavesTheSchemaToTheApplicationSoTheTableIsMissing() {
        DriverManagerDataSource source = memory("never");
        runner.withBean("only", DataSource.class, () -> source).withPropertyValues("datum.jdbc.initialize-schema=never").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(hasTable(source)).isFalse();
            assertThatThrownBy(() -> context.getBean(DefinitionSnapshotStore.class).record("contact", "b".repeat(64), definition()))
                .isInstanceOf(DataAccessException.class);
        });
    }

    @Test
    void aTableTheApplicationsOwnMigrationMadeIsNotMadeTwice() {
        DriverManagerDataSource source = memory("migrated");
        new JdbcTemplate(source).execute("CREATE TABLE datum_definition_snapshot (form_key VARCHAR(128) NOT NULL, sha256 CHAR(64) NOT NULL, "
            + "version VARCHAR(64) NOT NULL DEFAULT '', definition CLOB NOT NULL, created BIGINT NOT NULL, PRIMARY KEY (form_key, sha256))");
        runner.withBean("only", DataSource.class, () -> source).withPropertyValues("datum.jdbc.initialize-schema=always")
            .run(context -> assertThat(context).hasNotFailed());
    }

    @Test
    void theDataSourceMarkedForDatumIsTheOneTheStoreUsesBesideAPrimary() {
        runner.withUserConfiguration(TwoWithAMarked.class).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(DefinitionSnapshotStore.class)).isInstanceOf(JdbcDefinitionSnapshotStore.class);
            assertThat(hasTable(TwoWithAMarked.DATUM)).as("the marked database got the table").isTrue();
            assertThat(new JdbcTemplate(TwoWithAMarked.APPLICATION).queryForObject(
                "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'DATUM_DEFINITION_SNAPSHOT'", Integer.class))
                .as("the primary database was left alone").isZero();
            context.getBean(DefinitionSnapshotStore.class).record("contact", "c".repeat(64), definition());
            assertThat(new JdbcTemplate(TwoWithAMarked.DATUM).queryForObject("SELECT COUNT(*) FROM datum_definition_snapshot", Integer.class)).isEqualTo(1);
        });
    }

    @Test
    void twoPlainDataSourcesStillFallBackToMemoryWithoutTouchingEither() {
        DriverManagerDataSource one = memory("one");
        DriverManagerDataSource two = memory("two");
        runner.withBean("one", DataSource.class, () -> one).withBean("two", DataSource.class, () -> two).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(DefinitionSnapshotStore.class)).isInstanceOf(InMemoryDefinitionSnapshotStore.class);
            assertThat(hasTable(one)).isFalse();
            assertThat(hasTable(two)).isFalse();
        });
    }
}
