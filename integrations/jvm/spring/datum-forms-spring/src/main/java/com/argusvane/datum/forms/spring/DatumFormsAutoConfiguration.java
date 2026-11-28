package com.argusvane.datum.forms.spring;

import com.argusvane.datum.core.DatumEventPublisher;
import com.argusvane.datum.core.DatumStartupCheck;
import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.sandbox.protocol.Sandbox;
import com.argusvane.datum.forms.DefinitionCustomizer;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.FormDefinitionRepository;
import com.argusvane.datum.forms.FormsSettings;
import com.argusvane.datum.forms.ResourceFormDefinitionRepository;
import com.argusvane.datum.forms.datasource.CompositeDataSourceProvider;
import com.argusvane.datum.forms.datasource.DataSourceOptions;
import com.argusvane.datum.forms.datasource.DataSourceProvider;
import com.argusvane.datum.forms.snapshot.DefinitionSnapshotStore;
import com.argusvane.datum.forms.snapshot.InMemoryDefinitionSnapshotStore;
import com.argusvane.datum.forms.translation.InMemoryTranslationCatalogStore;
import com.argusvane.datum.forms.translation.TranslationCatalogStore;
import com.argusvane.datum.springweb.spring.ConditionalOnDatumDataSource;
import com.argusvane.datum.springweb.spring.DatumDataSource;
import com.argusvane.datum.springweb.spring.DatumDataSources;
import com.argusvane.datum.springweb.spring.DatumStoreJdbc;
import com.argusvane.datum.springweb.spring.JdbcSchemaInitializer;
import com.argusvane.datum.springweb.spring.SpringEventPublisher;
import java.time.Clock;
import java.time.Duration;
import java.util.concurrent.Executor;
import javax.sql.DataSource;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.sql.init.dependency.DependsOnDatabaseInitialization;
import org.springframework.boot.task.ThreadPoolTaskExecutorBuilder;
import org.springframework.context.ApplicationContext;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.PlatformTransactionManager;

/**
 * The forms module's beans, each replaceable by an application bean of the same type
 * ({@code @ConditionalOnMissingBean}): the resource repository, the snapshot store (JDBC when the application has
 * one {@code DataSource}, else bounded in memory with a startup warning), the definition service, the
 * translation store and the data-source options helper. There is deliberately no default {@link DataSourceProvider}:
 * without one the data-source endpoint answers 404. There is no access policy either (framework-first):
 * who may call a route is the application's Spring Security, with datum-spring-web's {@code DatumRequestMatchers}.
 *
 * <p>Web endpoints live in the {@code web.mvc} and {@code web.webflux} packages of this module and are
 * configured by the web adapters' own auto-configuration. Switch the whole module off with
 * {@code datum.enabled=false}.
 *
 * <p>The Spring binding of the forms library: the settings come from {@link FormsSettings},
 * events go through the {@code datumEventPublisher} bean ({@link SpringEventPublisher#of}), the JDBC store is {@link JdbcDefinitionSnapshotStore} on Spring's
 * JDBC (a transaction of its own per call, under the application's transaction manager when that is its only
 * one and a JDBC manager of the data source, see {@link DatumStoreJdbc}), and the class path half of
 * {@code datum.forms.locations} is {@link SpringFormSources}.
 */
@AutoConfiguration(afterName = {
    "org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration",
    "org.springframework.boot.jdbc.autoconfigure.JdbcTemplateAutoConfiguration"
})
@ConditionalOnProperty(prefix = "datum", name = "enabled", matchIfMissing = true)
@EnableConfigurationProperties(DatumFormsProperties.class)
public final class DatumFormsAutoConfiguration {

    /** {@code datum.forms.*} as the library reads it. */
    @Bean
    @ConditionalOnMissingBean
    FormsSettings datumFormsSettings(DatumFormsProperties properties) {
        return properties.toSettings();
    }

    /** The JDBC snapshot store, when the application has one DataSource and Spring's JDBC. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass({DataSource.class, JdbcClient.class})
    static class JdbcSnapshotStoreConfiguration {

        @Bean
        // With two DataSources, no primary and none marked @DatumDataSource there is no one to take: fall back to memory (with its
        // warning) rather than stop the context (mark one, or define a DefinitionSnapshotStore bean).
        @ConditionalOnDatumDataSource
        @ConditionalOnMissingBean(DefinitionSnapshotStore.class)
        @DependsOnDatabaseInitialization
        DefinitionSnapshotStore datumJdbcDefinitionSnapshotStore(@DatumDataSource ObjectProvider<DataSource> datumDataSource,
                                                                 ObjectProvider<DataSource> dataSource,
                                                                 ObjectProvider<JdbcSchemaInitializer> schema,
                                                                 ObjectProvider<PlatformTransactionManager> transactions, ObjectProvider<Clock> clock) {
            // The data source marked @DatumDataSource, else the single or primary one, with this module's table made when
            // datum.jdbc.initialize-schema asks and it is missing.
            DataSource chosen = DatumDataSources.prepare(datumDataSource, dataSource, schema, JdbcSchemaInitializer.Schema.FORMS);
            // The application's Clock bean when it has one: the time every snapshot row is stamped with.
            return new JdbcDefinitionSnapshotStore(DatumStoreJdbc.forApplication(chosen, transactions), clock.getIfAvailable(Clock::systemUTC));
        }
    }

    @Bean
    @ConditionalOnMissingBean(FormDefinitionRepository.class)
    FormDefinitionRepository datumResourceFormDefinitionRepository(ApplicationContext context, FormsSettings settings) {
        return new ResourceFormDefinitionRepository(SpringFormSources.resolver(context), settings.locations());
    }

    @Bean
    @ConditionalOnMissingBean(DefinitionSnapshotStore.class)
    DefinitionSnapshotStore datumInMemoryDefinitionSnapshotStore(FormsSettings settings) {
        return new InMemoryDefinitionSnapshotStore(settings.snapshotMaxEntries());
    }

    /**
     * The WARN for the in-memory snapshot store, written with the other start-up notices once every bean exists rather than by the store's constructor, so a store a test builds is silent.
     */
    @Bean
    DatumStartupCheck datumSnapshotStoreStartupCheck(ObjectProvider<DefinitionSnapshotStore> store) {
        // Any in-memory store in the context is reported, not only a unique one, so a second non-primary store does not hide it.
        return () -> store.orderedStream().filter(InMemoryDefinitionSnapshotStore.class::isInstance).findFirst()
            .map(memory -> InMemoryDefinitionSnapshotStore.startupCheck(memory).check()).orElse(java.util.List.of());
    }

    /**
     * The definitions, their public copies and save checks. The kernel runs go through the {@link Sandbox} bean, asked on
     * every call (the submissions binding's is a prototype that follows the runtime), so the receiver, the inspection and
     * this service share one sandbox and one decorator sees every run. The application's
     * {@link DefinitionCustomizer} beans adjust each public copy on its way to a filler.
     */
    @Bean
    @ConditionalOnMissingBean
    DefinitionService datumDefinitionService(FormDefinitionRepository repository, DefinitionSnapshotStore snapshots,
                                             ObjectProvider<Sandbox> sandbox, ObjectProvider<DatumEventPublisher> publisher,
                                             ApplicationEventPublisher events,
                                             FormsSettings settings, ObjectProvider<Clock> clock,
                                             ObjectProvider<DefinitionCustomizer> customizers) {
        return DefinitionService.builder()
            .repository(repository)
            .snapshots(snapshots)
            .sandbox(() -> {
                Sandbox service = sandbox.getIfAvailable();
                if (service == null) {
                    throw new ProgramUnavailableException("The Datum sandbox runtime is not configured, so this definition cannot be checked or made public.");
                }
                return service;
            })
            .events(SpringEventPublisher.of(publisher, events))
            .publicCacheSize(settings.publicCopyCacheSize())
            .clock(clock.getIfAvailable(Clock::systemUTC))
            .tooCostlyMemory(settings.tooCostlyMemory())
            // Every DefinitionCustomizer bean, in the framework's order.
            .customizers(customizers.orderedStream().toList())
            .build();
    }

    @Bean
    @ConditionalOnMissingBean(TranslationCatalogStore.class)
    TranslationCatalogStore datumInMemoryTranslationCatalogStore() {
        return new InMemoryTranslationCatalogStore();
    }

    /** The bean name of the executor data-source calls run on; an application replaces the pool by defining a bean of this name. */
    static final String DATA_SOURCE_EXECUTOR = "datumDataSourceExecutor";

    /**
     * The pool provider calls run on (framework-first): built from Spring Boot's {@code ThreadPoolTaskExecutorBuilder}
     * bean, so what the application set there applies: {@code spring.task.execution.*} (the task decorator, the shutdown
     * settings) and its {@code ThreadPoolTaskExecutorCustomizer} beans (MDC, tracing, a thread group), which run first and are
     * kept (never replaced by {@code customizers(..)}). Datum's own customizer runs last and
     * re-applies the bound, so no customizer can widen it: a small elastic pool of daemon threads, core size 0, no queue, idle
     * threads ended after 30 seconds, and a refusal ({@code AbortPolicy}) past {@code datum.forms.data-sources.max-threads}, so a
     * hung provider can hold at most that many threads and a call past them fails at once rather than queueing or running on the
     * caller. The thread name prefix is Datum's ({@code datum-data-source-}) unless a customizer renames it.
     *
     * <p>Platform threads on purpose: this is a bounded pool for providers that may hang, and Boot's virtual-thread switch
     * ({@code spring.threads.virtual.enabled}) does not reach it (Boot makes a {@code SimpleAsyncTaskExecutor} for virtual
     * threads, which this pool never is); a customizer that turns virtual threads on keeps the same bound.
     *
     * <p>An application bean named {@code datumDataSourceExecutor} (any {@code Executor}) replaces it, and then the property is
     * not read. The pool lives in a holder that is not itself an {@code Executor} bean, so the application's
     * {@code applicationTaskExecutor} and its {@code @Async} default stay as they were.
     */
    @Bean(name = DATA_SOURCE_EXECUTOR)
    @ConditionalOnMissingBean(name = DATA_SOURCE_EXECUTOR)
    DataSourceExecutor datumDataSourceExecutor(ObjectProvider<ThreadPoolTaskExecutorBuilder> builder, FormsSettings settings) {
        int maxThreads = settings.dataSourceMaxThreads();
        return new DataSourceExecutor(builder.getIfAvailable(ThreadPoolTaskExecutorBuilder::new)
            .corePoolSize(0)
            .maxPoolSize(maxThreads)
            .queueCapacity(0)
            .keepAlive(Duration.ofSeconds(30))
            .allowCoreThreadTimeOut(true)
            .threadNamePrefix("datum-data-source-")
            // Added after the application's customizers (additionalCustomizers keeps them; customizers(..) would drop them),
            // so this runs last and the bound holds whatever they set.
            .additionalCustomizers(executor -> {
                executor.setCorePoolSize(0);
                executor.setMaxPoolSize(maxThreads);
                executor.setQueueCapacity(0);
                executor.setKeepAliveSeconds(30);
                executor.setAllowCoreThreadTimeOut(true);
                executor.setRejectedExecutionHandler(new java.util.concurrent.ThreadPoolExecutor.AbortPolicy());
                executor.setDaemon(true);
            })
            .build());
    }

    @Bean
    @ConditionalOnMissingBean
    DataSourceOptions datumDataSourceOptions(ObjectProvider<DataSourceProvider> provider, FormsSettings settings,
                                             @Qualifier(DATA_SOURCE_EXECUTOR) Object pool) {
        Executor executor = pool instanceof DataSourceExecutor holder ? holder.executor() : (Executor) pool;
        return new DataSourceOptions(chosen(provider), settings.dataSourceTimeout(), executor);
    }

    /**
     * The provider the options use. One bean, or one marked {@code @Primary}, is used as it
     * is. Two or more with none primary are asked in turn, in the framework's order ({@code @Order},
     * {@code Ordered}), the first whose {@code exists(id)} is true answering: separate modules each contribute a source
     * without the application writing a dispatcher.
     */
    static DataSourceProvider chosen(ObjectProvider<DataSourceProvider> provider) {
        DataSourceProvider unique = provider.getIfUnique();
        return unique != null ? unique : CompositeDataSourceProvider.of(provider.orderedStream().toList());
    }
}
