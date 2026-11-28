package com.argusvane.datum.forms;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.forms.datasource.DataSourceOptions;
import com.argusvane.datum.forms.datasource.DataSourceProvider;
import com.argusvane.datum.forms.snapshot.DefinitionSnapshotStore;
import com.argusvane.datum.forms.snapshot.InMemoryDefinitionSnapshotStore;
import com.argusvane.datum.forms.spring.JdbcDefinitionSnapshotStore;
import com.argusvane.datum.forms.spring.DatumFormsAutoConfiguration;
import com.argusvane.datum.forms.spring.DatumFormsProperties;
import com.argusvane.datum.forms.translation.InMemoryTranslationCatalogStore;
import com.argusvane.datum.forms.translation.TranslationCatalogStore;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/** The default beans, what replaces them, and the switches. */
class DatumFormsAutoConfigurationTest {

    @TempDir
    Path dir;

    private ApplicationContextRunner runner() {
        return new ApplicationContextRunner().withConfiguration(AutoConfigurations.of(DatumFormsAutoConfiguration.class));
    }

    @Test
    void defaultsAreInMemoryAndResourceBased() throws IOException {
        Files.writeString(dir.resolve("contact.json"), "{\"id\":\"contact\",\"root\":{}}");

        runner().withPropertyValues("datum.forms.locations=file:" + dir.toAbsolutePath() + "/*.json").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(FormDefinitionRepository.class)).isInstanceOf(ResourceFormDefinitionRepository.class);
            assertThat(context.getBean(FormDefinitionRepository.class).find("contact")).isPresent();
            assertThat(context.getBean(DefinitionSnapshotStore.class)).isInstanceOf(InMemoryDefinitionSnapshotStore.class);
            assertThat(context.getBean(TranslationCatalogStore.class)).isInstanceOf(InMemoryTranslationCatalogStore.class);
            assertThat(context.getBean(DataSourceOptions.class).available()).as("no default provider").isFalse();
            assertThat(context.getBean(DefinitionService.class).current("contact").sha256()).hasSize(64);
        });
    }

    @Test
    void withNoFormsDirectoryTheDefaultLocationFindsNothingAndStarts() {
        runner().run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(((ResourceFormDefinitionRepository) context.getBean(FormDefinitionRepository.class)).size()).isZero();
        });
    }

    /** The store takes the application's one DataSource. */
    @Test
    void aDataSourceBeanSwitchesTheSnapshotStoreToJdbc() {
        runner().withBean(DataSource.class, () -> new DriverManagerDataSource("jdbc:h2:mem:" + UUID.randomUUID(), "sa", ""))
            .run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context).hasSingleBean(DefinitionSnapshotStore.class);
                assertThat(context.getBean(DefinitionSnapshotStore.class)).isInstanceOf(JdbcDefinitionSnapshotStore.class);
                // Made after Flyway, Liquibase or spring.sql.init.
                assertThat(context.getBeanFactory().findAnnotationOnBean("datumJdbcDefinitionSnapshotStore", org.springframework.boot.sql.init.dependency.DependsOnDatabaseInitialization.class)).isNotNull();
            });
    }

    /** The application's transaction manager over the one DataSource is the one the store's calls run under. */
    @Test
    void theStoreRunsUnderTheApplicationsTransactionManagerForItsDataSource() {
        DataSource source = new DriverManagerDataSource("jdbc:h2:mem:" + UUID.randomUUID(), "sa", "");
        org.springframework.transaction.PlatformTransactionManager application = new org.springframework.jdbc.datasource.DataSourceTransactionManager(source);
        runner().withBean(DataSource.class, () -> source).withBean(org.springframework.transaction.PlatformTransactionManager.class, () -> application)
            .run(context -> {
                assertThat(context).hasNotFailed();
                com.argusvane.datum.springweb.spring.DatumStoreJdbc jdbc = (com.argusvane.datum.springweb.spring.DatumStoreJdbc)
                    org.springframework.test.util.ReflectionTestUtils.getField(context.getBean(DefinitionSnapshotStore.class), "jdbc");
                assertThat(jdbc.transactionManager()).isSameAs(application);
                assertThat(jdbc.dataSource()).isSameAs(source);
            });
    }

    @Test
    void twoDataSourcesWithoutAPrimaryFallBackToMemory() {
        runner().withBean("one", DataSource.class, () -> new DriverManagerDataSource("jdbc:h2:mem:" + UUID.randomUUID(), "sa", ""))
            .withBean("two", DataSource.class, () -> new DriverManagerDataSource("jdbc:h2:mem:" + UUID.randomUUID(), "sa", ""))
            .run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(DefinitionSnapshotStore.class)).isInstanceOf(InMemoryDefinitionSnapshotStore.class);
            });
    }

    @Test
    void applicationBeansReplaceTheDefaults() {
        DefinitionSnapshotStore store = new InMemoryDefinitionSnapshotStore(3);
        runner().withBean("appStore", DefinitionSnapshotStore.class, () -> store)
            .run(context -> {
                assertThat(context).hasSingleBean(DefinitionSnapshotStore.class);
                assertThat(context.getBean(DefinitionSnapshotStore.class)).isSameAs(store);
            });
    }

    @Test
    void datumEnabledFalseSwitchesTheModuleOff() {
        runner().withPropertyValues("datum.enabled=false").run(context -> assertThat(context).doesNotHaveBean(DefinitionService.class));
    }

    @Test
    void thePropertiesBind() {
        runner().withPropertyValues("datum.forms.snapshots.max-entries=7", "datum.forms.data-sources.timeout=3s", "datum.forms.public-copy=x")
            .run(context -> {
                DatumFormsProperties properties = context.getBean(DatumFormsProperties.class);
                assertThat(properties.getSnapshots().getMaxEntries()).isEqualTo(7);
                assertThat(properties.getDataSources().getTimeout()).hasSeconds(3);
            });
    }

    /** The literal defaults (kept for the configuration metadata) are the library's. */
    @Test
    void theDefaultsAreTheSettingsDefaults() {
        assertThat(new DatumFormsProperties().toSettings()).isEqualTo(FormsSettings.defaults());
    }

    /** A value that cannot work stops the context naming the property, as every Spring Boot setting does. */
    @Test
    void aSettingThatCannotWorkStopsTheStartNamingTheProperty() {
        for (String[] bad : new String[][] {
            {"datum.forms.snapshots.max-entries=0", "datum.forms.snapshots.max-entries"},
            {"datum.forms.snapshots.public-copy-cache-size=0", "datum.forms.snapshots.public-copy-cache-size"},
            {"datum.forms.data-sources.timeout=0s", "datum.forms.data-sources.timeout"},
            {"datum.forms.data-sources.max-threads=0", "datum.forms.data-sources.max-threads"}}) {
            runner().withPropertyValues(bad[0]).run(context -> {
                assertThat(context).as(bad[0]).hasFailed();
                assertThat(context.getStartupFailure()).as(bad[0]).hasStackTraceContaining(bad[1]);
            });
        }
    }

    // ------------------------------------------------------------------------------------------------------ the clock

    /** The application's Clock bean reaches the definition service (too-costly memory) and the JDBC snapshot store. */
    @Test
    void theApplicationsClockReachesTheDefinitionServiceAndTheSnapshotStore() {
        java.time.Clock clock = java.time.Clock.fixed(java.time.Instant.parse("2026-01-02T03:04:05Z"), java.time.ZoneOffset.UTC);
        runner().withBean(java.time.Clock.class, () -> clock)
            .withBean(DataSource.class, () -> new DriverManagerDataSource("jdbc:h2:mem:" + UUID.randomUUID(), "sa", ""))
            .run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(org.springframework.test.util.ReflectionTestUtils.getField(context.getBean(DefinitionService.class), "clock")).isSameAs(clock);
                assertThat(org.springframework.test.util.ReflectionTestUtils.getField(context.getBean(DefinitionSnapshotStore.class), "clock"))
                    .isSameAs(clock);
            });
        runner().run(context -> assertThat(org.springframework.test.util.ReflectionTestUtils.getField(context.getBean(DefinitionService.class), "clock"))
            .as("no Clock bean: the system clock").isNotNull());
    }

    /** Settings that reach the library: the too-costly memory and the two Cache-Control values. */
    @Test
    void theNewPropertiesBindAndCannotBeOutsideTheirBounds() {
        runner().withPropertyValues("datum.forms.too-costly-memory=45s", "datum.forms.cache.definition=private, max-age=30",
            "datum.forms.cache.snapshot=public, max-age=600").run(context -> {
                FormsSettings settings = context.getBean(FormsSettings.class);
                assertThat(settings.tooCostlyMemory()).hasSeconds(45);
                assertThat(settings.definitionCacheControl()).isEqualTo("private, max-age=30");
                assertThat(settings.snapshotCacheControl()).isEqualTo("public, max-age=600");
            });
        for (String[] bad : new String[][] {{"datum.forms.too-costly-memory=0s", "datum.forms.too-costly-memory"},
            {"datum.forms.too-costly-memory=2h", "datum.forms.too-costly-memory"}, {"datum.forms.cache.definition= ", "datum.forms.cache.definition"}}) {
            runner().withPropertyValues(bad[0]).run(context -> {
                assertThat(context).as(bad[0]).hasFailed();
                assertThat(context.getStartupFailure()).as(bad[0]).hasStackTraceContaining(bad[1]);
            });
        }
    }

    /** An application's FormsSettings bean wins over the properties (every settings record bean backs off). */
    @Test
    void anApplicationsSettingsBeanReplacesTheOneFromProperties() {
        FormsSettings mine = new FormsSettings(java.util.List.of(), 9, 9, java.time.Duration.ofSeconds(2), 2, java.time.Duration.ofSeconds(77), "no-cache", null);
        runner().withBean(FormsSettings.class, () -> mine).withPropertyValues("datum.forms.snapshots.max-entries=7").run(context -> {
            assertThat(context).hasSingleBean(FormsSettings.class);
            assertThat(context.getBean(FormsSettings.class)).isSameAs(mine);
        });
    }

    /**
     * Data-source calls run on an executor the binding builds from Spring's ThreadPoolTaskExecutorBuilder (so the application's
     * customisations apply), bounded by max-threads, and an application bean of the same name replaces it.
     */
    @Test
    void theDataSourceExecutorIsBuiltFromSpringsBuilderAndReplaceableByName() {
        java.util.concurrent.atomic.AtomicInteger decorated = new java.util.concurrent.atomic.AtomicInteger();
        runner().withPropertyValues("datum.forms.data-sources.max-threads=3")
            .withBean(org.springframework.boot.task.ThreadPoolTaskExecutorBuilder.class,
                () -> new org.springframework.boot.task.ThreadPoolTaskExecutorBuilder().taskDecorator(task -> {
                    decorated.incrementAndGet();
                    return task;
                }))
            .run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBeansOfType(java.util.concurrent.Executor.class)).as("the pool is not an Executor bean").isEmpty();
                org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor executor =
                    (org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor) org.springframework.test.util.ReflectionTestUtils
                        .getField(context.getBean(DataSourceOptions.class), "executor");
                assertThat(executor.getMaxPoolSize()).isEqualTo(3);
                assertThat(executor.getCorePoolSize()).isZero();
                assertThat(executor.getThreadNamePrefix()).isEqualTo("datum-data-source-");
                assertThat(executor.isDaemon()).isTrue();
                assertThat(org.springframework.test.util.ReflectionTestUtils.getField(context.getBean(DataSourceOptions.class), "executor"))
                    .isSameAs(executor);
                java.util.concurrent.CountDownLatch ran = new java.util.concurrent.CountDownLatch(1);
                executor.execute(ran::countDown);
                assertThat(ran.await(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                assertThat(decorated.get()).as("the application's builder customisation applied").isPositive();
            });
        java.util.concurrent.Executor mine = Runnable::run;
        runner().withBean("datumDataSourceExecutor", java.util.concurrent.Executor.class, () -> mine).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).doesNotHaveBean(org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor.class);
            assertThat(org.springframework.test.util.ReflectionTestUtils.getField(context.getBean(DataSourceOptions.class), "executor")).isSameAs(mine);
        });
    }

    /**
     * The application's {@code ThreadPoolTaskExecutorCustomizer} beans (which Boot's builder bean carries) reach
     * the provider pool, as its javadoc says, and run before Datum's own shaping, so none can widen the bound: the pool size,
     * the queue, the refusal past max-threads and the daemon flag are re-applied after them.
     */
    @Test
    void theApplicationsExecutorCustomizersApplyButCannotWidenTheBound() {
        java.util.concurrent.atomic.AtomicInteger decorated = new java.util.concurrent.atomic.AtomicInteger();
        runner().withConfiguration(org.springframework.boot.autoconfigure.AutoConfigurations.of(
                org.springframework.boot.autoconfigure.task.TaskExecutionAutoConfiguration.class))
            .withPropertyValues("datum.forms.data-sources.max-threads=3")
            .withBean("tracing", org.springframework.boot.task.ThreadPoolTaskExecutorCustomizer.class, () -> executor -> {
                executor.setTaskDecorator(task -> {
                    decorated.incrementAndGet();
                    return task;
                });
                executor.setThreadGroupName("application-group");
            })
            .withBean("widening", org.springframework.boot.task.ThreadPoolTaskExecutorCustomizer.class, () -> executor -> {
                executor.setCorePoolSize(40);
                executor.setMaxPoolSize(100);
                executor.setQueueCapacity(1000);
                executor.setAllowCoreThreadTimeOut(false);
                executor.setDaemon(false);
                executor.setRejectedExecutionHandler(new java.util.concurrent.ThreadPoolExecutor.CallerRunsPolicy());
            })
            .run(context -> {
                assertThat(context).hasNotFailed();
                org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor executor =
                    (org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor) org.springframework.test.util.ReflectionTestUtils
                        .getField(context.getBean(DataSourceOptions.class), "executor");
                assertThat(executor.getThreadGroup().getName()).as("the application's customizer ran").isEqualTo("application-group");
                assertThat(executor.getMaxPoolSize()).as("and could not widen the bound").isEqualTo(3);
                assertThat(executor.getCorePoolSize()).isZero();
                assertThat(executor.getQueueCapacity()).isZero();
                assertThat(executor.getThreadPoolExecutor().allowsCoreThreadTimeOut()).isTrue();
                assertThat(executor.isDaemon()).isTrue();
                assertThat(executor.getThreadPoolExecutor().getRejectedExecutionHandler())
                    .isInstanceOf(java.util.concurrent.ThreadPoolExecutor.AbortPolicy.class);
                java.util.concurrent.CountDownLatch ran = new java.util.concurrent.CountDownLatch(1);
                executor.execute(ran::countDown);
                assertThat(ran.await(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                assertThat(decorated.get()).as("the application's task decorator wraps provider calls").isPositive();
                assertThat(context.getBeansOfType(java.util.concurrent.Executor.class).keySet()).containsExactly("applicationTaskExecutor");
            });
    }

    /**
     * Adding the forms binding must not take Boot's {@code applicationTaskExecutor} away (Boot backs it off when any Executor
     * bean exists): next to the task execution configuration it is still the one Executor bean.
     */
    @Test
    void theApplicationTaskExecutorSurvivesTheFormsBinding() {
        runner().withConfiguration(org.springframework.boot.autoconfigure.AutoConfigurations.of(
                org.springframework.boot.autoconfigure.task.TaskExecutionAutoConfiguration.class))
            .run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBeansOfType(java.util.concurrent.Executor.class).keySet()).containsExactly("applicationTaskExecutor");
                assertThat(context).hasSingleBean(DataSourceOptions.class);
            });
    }

    /** An owner of some source ids, for the provider tests. */
    private static DataSourceProvider owning(String... ids) {
        java.util.Set<String> owned = java.util.Set.of(ids);
        return new DataSourceProvider() {
            @Override
            public java.util.List<com.argusvane.datum.core.contracts.OptionItem> items(String id, String locale, java.security.Principal principal) {
                return java.util.List.of();
            }

            @Override
            public boolean exists(String id) {
                return owned.contains(id);
            }
        };
    }

    private static Object providerOf(org.springframework.context.ApplicationContext context) {
        return org.springframework.test.util.ReflectionTestUtils.getField(context.getBean(DataSourceOptions.class), "provider");
    }

    @Test
    void oneProviderBeanIsUsedAlone() {
        DataSourceProvider only = owning("a");
        runner().withBean("only", DataSourceProvider.class, () -> only).run(context -> assertThat(providerOf(context)).isSameAs(only));
    }

    @Test
    void severalProviderBeansAreAskedInTheFrameworksOrder() {
        DataSourceProvider late = owning("shared", "late");
        DataSourceProvider early = owning("shared", "early");
        runner().withBean("late", DataSourceProvider.class, () -> late).withBean("early", DataSourceProvider.class, () -> early)
            .run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(providerOf(context)).isInstanceOf(com.argusvane.datum.forms.datasource.CompositeDataSourceProvider.class);
                var composite = (com.argusvane.datum.forms.datasource.CompositeDataSourceProvider) providerOf(context);
                assertThat(composite.providers()).containsExactly(late, early);
                assertThat(composite.exists("early")).isTrue();
                assertThat(composite.exists("late")).isTrue();
                assertThat(composite.exists("missing")).isFalse();
            });
    }

    @Test
    void aPrimaryProviderAmongSeveralStaysTheOnlyOne() {
        DataSourceProvider chosen = owning("a");
        runner().withBean("chosen", DataSourceProvider.class, () -> chosen, definition -> definition.setPrimary(true))
            .withBean("other", DataSourceProvider.class, () -> owning("b")).run(context -> assertThat(providerOf(context)).isSameAs(chosen));
    }
}
