package com.argusvane.datum.submissions.spring;

import com.argusvane.datum.core.DatumEventPublisher;
import com.argusvane.datum.core.DatumStartupCheck;
import com.argusvane.datum.core.observation.DatumObservations;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.protocol.Sandbox;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.datasource.DataSourceOptions;
import com.argusvane.datum.forms.spring.DatumFormsAutoConfiguration;
import com.argusvane.datum.forms.translation.TranslationCatalogStore;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import com.argusvane.datum.springweb.spring.DatumProperties;
import com.argusvane.datum.springweb.spring.ConditionalOnDatumDataSource;
import com.argusvane.datum.springweb.spring.DatumDataSource;
import com.argusvane.datum.springweb.spring.DatumDataSources;
import com.argusvane.datum.springweb.spring.DatumStoreJdbc;
import com.argusvane.datum.springweb.spring.JdbcSchemaInitializer;
import com.argusvane.datum.springweb.spring.SpringEventPublisher;
import com.argusvane.datum.submissions.idempotency.InMemorySubmissionIdempotencyStore;
import com.argusvane.datum.submissions.metrics.SubmissionMetrics;
import com.argusvane.datum.submissions.receiver.LoggingSubmissionHandler;
import com.argusvane.datum.submissions.receiver.PreCheckStatuses;
import com.argusvane.datum.submissions.receiver.SubmissionReceiver;
import com.argusvane.datum.sandbox.runtime.DatumSandbox;
import com.argusvane.datum.sandbox.spring.DatumSandboxAutoConfiguration;
import com.argusvane.datum.sandbox.runtime.SandboxSettings;
import com.argusvane.datum.submissions.service.SubmissionService;
import com.argusvane.datum.submissions.spi.HostContextProvider;
import com.argusvane.datum.submissions.spi.HostOptionsCustomizer;
import com.argusvane.datum.submissions.spi.SandboxContextContributor;
import com.argusvane.datum.submissions.spi.SandboxRulesProvider;
import com.argusvane.datum.submissions.spi.SubmissionHandler;
import com.argusvane.datum.submissions.spi.SubmissionIdempotencyStore;
import com.argusvane.datum.submissions.spi.SubmissionPreCheck;
import com.argusvane.datum.submissions.spi.SubmissionSignatureCheck;
import com.argusvane.datum.submissions.spi.SubmissionThrottle;
import com.argusvane.datum.submissions.spi.SubmissionValidator;
import com.argusvane.datum.web.WebSettings;
import com.argusvane.datum.web.json.DatumJsonMapper;
import com.argusvane.datum.web.monitoring.DatumCapability;
import com.argusvane.datum.web.monitoring.DatumMeters;
import java.time.Clock;
import javax.sql.DataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.sql.init.dependency.DependsOnDatabaseInitialization;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.PlatformTransactionManager;

/**
 * The submissions capability: the receiver and the SPIs' defaults, over the sandbox datum-sandbox-spring provides (its lifecycle,
 * slots and ABI gate; this auto-configuration orders after it). Every bean backs off for
 * an application bean of the same type; {@code datum.enabled=false} switches the whole module off.
 *
 * <p>The class is in sections: the service and the receiver (the
 * transport-neutral {@code SubmissionService} and the HTTP receiver over it); the defaults of the SPIs. The in-memory throttle and the web endpoints are in their own
 * sections or configurations.
 *
 * <p>The Spring binding of the submissions library: the settings records ({@link SandboxSettings}, {@link WebSettings}) do the
 * clamping, the sandbox is datum-sandbox-spring's (a plain class started and stopped by its lifecycle), events go through the {@code datumEventPublisher} bean ({@link SpringEventPublisher#of}), and the JDBC idempotency store is
 * {@link JdbcSubmissionIdempotencyStore}, on Spring's JDBC over the application's one {@code DataSource}.
 */
@AutoConfiguration(after = {DatumWebAutoConfiguration.class, DatumFormsAutoConfiguration.class, DatumSandboxAutoConfiguration.class}, afterName = {
    "org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration",
    "org.springframework.boot.jdbc.autoconfigure.JdbcTemplateAutoConfiguration"
})
@ConditionalOnProperty(prefix = "datum", name = "enabled", matchIfMissing = true)
@EnableConfigurationProperties(DatumSubmissionsProperties.class)
public final class DatumSubmissionsAutoConfiguration {

    private static final Logger LOG = LoggerFactory.getLogger(DatumSubmissionsAutoConfiguration.class);

    /**
     * The {@code submissions} capability ({@code engine}, {@code engineRelease}, {@code engineMode} in {@code info.datum}),
     * with what the idempotency store and the throttle are: {@code idempotency} ({@code memory}, {@code jdbc} or
     * {@code custom}) when there is a store, {@code throttle: memory} when the throttle is the in-memory one. Read from the
     * beans the context has, so an application's runtime, store or throttle is reported as it is.
     */
    @Bean
    DatumCapability datumSubmissionsCapability(DatumSandbox runtime, ObjectProvider<SubmissionIdempotencyStore> idempotency,
                                               ObjectProvider<SubmissionThrottle> throttle) {
        DatumCapability capability = DatumCapability.of("submissions")
            .withDetail("engine", runtime::engine)
            .withDetail("engineRelease", () -> runtime.engineInfo().version())
            .withDetail("engineMode", () -> runtime.engineInfo().mode());
        SubmissionIdempotencyStore store = idempotency.getIfAvailable();
        if (store != null) {
            String kind = store instanceof InMemorySubmissionIdempotencyStore ? "memory"
                : store instanceof JdbcSubmissionIdempotencyStore ? "jdbc" : "custom";
            capability = capability.withDetail("idempotency", () -> kind);
        }
        if (throttle.getIfAvailable() instanceof InMemorySubmissionThrottle) {
            capability = capability.withDetail("throttle", () -> "memory");
        }
        return capability;
    }

    /**
     * The sandbox a caller runs on, looked up on every call: the runtime's {@code DatumSandboxAutoConfiguration#SANDBOX} bean (datum-sandbox-spring's; as a
     * post-processor left it), else the runtime's refusal naming why it is down (503 {@code server.unavailable}), never a sandbox from around
     * the bean.
     */
    static java.util.function.Supplier<Sandbox> sandboxOf(ObjectProvider<Sandbox> sandbox, DatumSandbox runtime) {
        return () -> {
            Sandbox current = sandbox.getIfAvailable();
            if (current == null) {
                throw runtime.sandboxUnavailable();
            }
            return current;
        };
    }

    // =========================================================================================== the service and the receiver

    /**
     * The submission pipeline with no transport in it: every hook bean in the framework's order, the shared
     * sandbox bean, the idempotency store. The HTTP receiver hands every request to this bean, and an application that takes
     * documents another way (a queue consumer, a JDBC batch, a syncing device, a re-validation of stored records on the
     * current version) injects it and calls {@code submit}, {@code validate} or {@code test} with a {@code SubmissionContext}
     * of its channel: the same checks, the same idempotency store, the same events, its channel on each, the same size cap
     * ({@code datum.web.api.max-body-size}). Replaced by an application bean of this type.
     */
    @Bean
    @ConditionalOnMissingBean
    SubmissionService datumSubmissionService(DatumSandbox runtime, ObjectProvider<Sandbox> sandbox, DefinitionService definitions,
                                             DataSourceOptions dataSources, ObjectProvider<TranslationCatalogStore> catalogs,
                                             SandboxSettings settings, SubmissionHandler handler,
                                             ObjectProvider<SubmissionThrottle> throttle, ObjectProvider<SubmissionPreCheck> preChecks,
                                             ObjectProvider<SubmissionValidator> validators, ObjectProvider<SandboxRulesProvider> rules,
                                             ObjectProvider<SandboxContextContributor> contributors,
                                             ObjectProvider<HostOptionsCustomizer> customizers,
                                             ObjectProvider<SubmissionSignatureCheck> signature,
                                             ObjectProvider<SubmissionIdempotencyStore> idempotency,
                                             ObjectProvider<DatumEventPublisher> publisher, ApplicationEventPublisher events,
                                             ProgramLimits limits, ObjectProvider<DatumObservations> observations,
                                             ObjectProvider<HostContextProvider> hostContext) {
        SubmissionIdempotencyStore store = idempotency.getIfAvailable();
        return SubmissionService.builder()
            // The shared sandbox bean, asked per submission before anything else: a runtime that is down answers 503
            // before any data source is asked.
            .sandbox(sandboxOf(sandbox, runtime))
            .definitions(definitions)
            .dataSources(dataSources)
            // The forms starter's catalog store: a run carries it beside the definition's map.
            .catalogs(catalogs.getIfAvailable())
            .unknownFields(settings.host().unknownFields())
            .logLevel(settings.host().logLevel())
            .handler(handler)
            .throttle(throttle.getIfAvailable())
            // The framework's order (@Order, Ordered, @Priority); equal orders keep registration order.
            .preChecks(preChecks.orderedStream().toList())
            .validators(validators.orderedStream().toList())
            .rulesProviders(rules.orderedStream().toList())
            .contributors(contributors.orderedStream().toList())
            .customizers(customizers.orderedStream().toList())
            .signatureCheck(signature.getIfAvailable())
            // The application's one HostContextProvider, or none: two are refused at start-up (getIfAvailable
            // throws for more than one), never one picked silently, since the context decides which rules are judged.
            .hostContext(hostContext.getIfAvailable())
            .idempotency(store)
            .events(SpringEventPublisher.of(publisher, events))
            // datum.submission per call, under the HTTP request's observation; none without a registry.
            .observations(observations.getIfAvailable(DatumObservations::none))
            // The routes' body cap, held to a caller with no bytes too (a tree from a queue, a batch, a sync): one cap for
            // every channel, measured on the tree as the fewest bytes its text can take, so a body a route took fits.
            .maxDocumentBytes(limits.maxBodyBytes())
            .build();
    }

    /**
     * The HTTP admission and mapping over the service bean: 415, the body cap, the parse, the body around the
     * document, the client facts of the request, then the service, then the outcome as the wire's status, code and headers.
     * A pre-check's refusal is answered with the status the application's {@link PreCheckStatuses} bean names for its code,
     * else the standard mapping (403 for every code; {@code PreCheckStatuses.bySuffix()} as the bean opts into
     * 422 {@code .invalid} and 503 {@code .unavailable}).
     */
    @Bean
    @ConditionalOnMissingBean
    SubmissionReceiver datumSubmissionReceiver(SubmissionService service, ObjectProvider<DatumJsonMapper> json, ProgramLimits limits,
                                               ObjectProvider<PreCheckStatuses> preCheckStatuses) {
        return SubmissionReceiver.builder()
            .service(service)
            .json(json.getIfAvailable(() -> DatumJsonMapper.create(limits.maxBodyBytes())))
            .maxBodyBytes(limits.maxBodyBytes())
            .preCheckStatuses(preCheckStatuses.getIfAvailable(PreCheckStatuses::standard))
            .build();
    }

    // =========================================================================================== SPI defaults

    /** Stores nothing: logs, answers a UUID, and WARNs at startup. Replace it with a handler that stores. */
    @Bean
    @ConditionalOnMissingBean(SubmissionHandler.class)
    SubmissionHandler datumLoggingSubmissionHandler() {
        return new LoggingSubmissionHandler();
    }

    // =========================================================================================== start-up checks

    /**
     * The library's start-up checks of this capability, run once every bean exists by datum-spring-web's runner: the WARN when the handler in use stores
     * nothing, and the one when the sandbox slots do not fit the container's memory beside the heap.
     */
    @Bean
    DatumStartupCheck datumSubmissionHandlerStartupCheck(ObjectProvider<SubmissionHandler> handlers) {
        // Any logging handler in the context is reported, not only a unique one: two handlers would otherwise fall silent.
        return () -> handlers.orderedStream().filter(LoggingSubmissionHandler.class::isInstance).findFirst()
            .map(logging -> LoggingSubmissionHandler.startupCheck(logging).check()).orElse(java.util.List.of());
    }

    // =========================================================================================== idempotency

    /** Carries the JDBC store's failed probe to {@link #datumIdempotencyStartupCheck} (the report is written once the beans exist). */
    @Bean
    IdempotencyProbe datumIdempotencyProbe() {
        return new IdempotencyProbe();
    }

    /**
     * The WARN for an idempotency store that forgets: the in-memory default, or the fallback when the JDBC table cannot
     * be read. Written with the other start-up notices so a test constructing a store hears nothing.
     */
    @Bean
    DatumStartupCheck datumIdempotencyStartupCheck(ObjectProvider<SubmissionIdempotencyStore> stores, IdempotencyProbe probe) {
        return () -> {
            InMemorySubmissionIdempotencyStore memory = stores.orderedStream().filter(InMemorySubmissionIdempotencyStore.class::isInstance)
                .map(InMemorySubmissionIdempotencyStore.class::cast).findFirst().orElse(null);
            if (memory == null) {
                return java.util.List.of();
            }
            String missing = probe.failure();
            return java.util.List.of(DatumStartupCheck.Notice.warn(DatumSubmissionsAutoConfiguration.class, missing != null
                ? "Datum: the application's DataSource is there but the table " + JdbcSubmissionIdempotencyStore.TABLE + " cannot be read ("
                    + missing + "); remembering accepted submissions in memory instead. Run "
                    + "META-INF/datum/db/migration/<database>/V200__datum_submissions.sql to use the JDBC store, or set "
                    + "datum.jdbc.initialize-schema=always to have Datum make the table."
                : "Datum: accepted submissions are remembered in memory (the last " + memory.maxEntries() + "), so a repeated delivery is "
                    + "answered with its first receipt only on this instance and until it restarts. Provide one DataSource bean, or mark one "
                    + "@Primary (table datum_submission_digest, META-INF/datum/db/migration/<database>/V200__datum_submissions.sql) or your "
                    + "own SubmissionIdempotencyStore bean."));
        };
    }

    /** Where the JDBC store leaves why it fell back to memory. */
    static final class IdempotencyProbe {

        private volatile String failure;

        void failed(String message) {
            failure = message == null ? "unknown" : message;
        }

        String failure() {
            return failure;
        }
    }

    /**
     * The JDBC idempotency store, when the application has one DataSource and Spring's JDBC (a transaction
     * of its own per call, under the application's transaction manager when that is its only one and a JDBC manager of
     * the data source, see {@link DatumStoreJdbc}).
     */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass({DataSource.class, JdbcClient.class})
    static class JdbcIdempotencyConfiguration {

        @Bean
        // With two DataSources, no primary and none marked @DatumDataSource there is no one to take: fall back to memory (with its
        // WARN) rather than stop the context (mark one, or define a SubmissionIdempotencyStore bean).
        @ConditionalOnDatumDataSource
        @ConditionalOnMissingBean(SubmissionIdempotencyStore.class)
        @DependsOnDatabaseInitialization
        SubmissionIdempotencyStore datumJdbcSubmissionIdempotencyStore(@DatumDataSource ObjectProvider<DataSource> datumDataSource,
                                                                       ObjectProvider<DataSource> anyDataSource,
                                                                       ObjectProvider<JdbcSchemaInitializer> schema,
                                                                       ObjectProvider<PlatformTransactionManager> transactions,
                                                                       ObjectProvider<Clock> clock, DatumSubmissionsProperties properties,
                                                                       IdempotencyProbe probe) {
            // The data source marked @DatumDataSource, else the single or primary one, with the table made when
            // datum.jdbc.initialize-schema asks and it is missing; the probe below then only fails for a table the
            // application's own migration tool has not made.
            DataSource dataSource = DatumDataSources.prepare(datumDataSource, anyDataSource, schema, JdbcSchemaInitializer.Schema.SUBMISSIONS);
            // Probe the table once at startup. A missing table (the application upgraded Datum without running
            // V200__datum_submissions.sql, or just has spring-data-jpa and so a DataSource) must not turn every
            // delivery into a 503 with no signal: fall back to memory, and say so loudly in the start-up report
            // (datumIdempotencyStartupCheck) instead of from this bean body.
            JdbcSubmissionIdempotencyStore store = new JdbcSubmissionIdempotencyStore(DatumStoreJdbc.forApplication(dataSource, transactions),
                clock.getIfAvailable(Clock::systemUTC));
            try {
                store.probe();
            } catch (RuntimeException missing) {
                probe.failed(missing.getMessage());
                return new InMemorySubmissionIdempotencyStore(properties.getIdempotency().checkedMemorySize());
            }
            return store;
        }
    }

    /**
     * The default idempotency store: the last {@link InMemorySubmissionIdempotencyStore#DEFAULT_MAX_ENTRIES}
     * accepted documents in this process ({@code datum.submissions.idempotency.memory-size}). Each instance remembers alone and a restart forgets, so the WARN names
     * the JDBC store (one {@code DataSource} bean, or a {@code @Primary} one among several, selects it; run
     * {@code V200__datum_submissions.sql}); the
     * detail {@code idempotency} on {@code info.datum} says {@code memory}, {@code jdbc} or {@code custom}.
     */
    @Bean
    @ConditionalOnMissingBean(SubmissionIdempotencyStore.class)
    SubmissionIdempotencyStore datumInMemorySubmissionIdempotencyStore(DatumSubmissionsProperties properties) {
        int size = properties.getIdempotency().checkedMemorySize();
        return new InMemorySubmissionIdempotencyStore(size);
    }

    // =========================================================================================== throttle, actuator, metrics

    /**
     * The default throttle: {@code datum.web.throttle.limit} attempts per {@code window} per
     * {@code by} key, and {@code datum.web.throttle.address-limit} requests per window per client address before the body
     * is read, in memory. Off with {@code datum.web.throttle.enabled=false}; replaced by an application
     * {@link SubmissionThrottle} bean (a gateway's, a shared store's). The client address is the one Spring's
     * {@code ForwardedHeaderFilter} left on the request, so behind a proxy enable it (see the class javadoc).
     * Each instance counts alone; the WARN and the {@code throttle} detail on {@code info.datum} say so.
     */
    @Bean
    @ConditionalOnMissingBean(SubmissionThrottle.class)
    @ConditionalOnProperty(prefix = "datum.web.throttle", name = "enabled", matchIfMissing = true)
    SubmissionThrottle datumInMemorySubmissionThrottle(ObjectProvider<DatumProperties> web, ObjectProvider<WebSettings> webSettings,
                                                       ObjectProvider<Clock> clock) {
        DatumProperties properties = web.getIfAvailable(DatumProperties::defaults);
        // The shared throttle settings come from the WebSettings bean (an application's own replaces the properties').
        WebSettings.Throttle settings = webSettings.getIfAvailable(properties::toSettings).throttle();
        // The per-kind limits, the bound on windows and the address limit are the development throttle's own (binding-level, not in
        // WebSettings).
        DatumProperties.Web.Throttle own = properties.web().throttle();
        InMemorySubmissionThrottle throttle = InMemorySubmissionThrottle.fromSettings(settings, own.limits(), own.maxKeys(), own.addressLimit(),
            clock.getIfAvailable(Clock::systemUTC));
        return throttle;
    }

    /**
     * The meters, when Micrometer is present: the submissions and throttle counters from the receiver's events (the sandbox's
     * run meters are datum-sandbox-spring's). {@link DatumMeters} (datum-spring-web) reads the registry lazily and does nothing
     * without one.
     */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(name = "io.micrometer.core.instrument.binder.MeterBinder")
    static class MetricsConfiguration {

        @Bean
        @ConditionalOnMissingBean
        @ConditionalOnBean(DatumMeters.class)
        SubmissionMetrics datumSubmissionMetrics(DatumMeters meters) {
            return new SubmissionMetrics(meters);
        }

        /** The receiver's application events into the library's counters. */
        @Bean
        @ConditionalOnBean(SubmissionMetrics.class)
        SubmissionMetricsListener datumSubmissionMetricsListener(SubmissionMetrics metrics) {
            return new SubmissionMetricsListener(metrics);
        }

    }

    // =========================================================================================== web endpoints

    /**
     * The submissions endpoints (POST submissions, submissions/validate, submissions/test, inspect) on MVC or
     * WebFlux, one switch each under {@code datum.web.api.endpoints.*}. The beans and both stack-specific
     * nested configurations live in {@code web.SubmissionsWebConfiguration}; the OpenAPI group is the separate
     * {@code web.DatumSubmissionsOpenApiAutoConfiguration}, which springdoc's ordering needs.
     */
    @Configuration(proxyBeanMethods = false)
    @org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication
    @org.springframework.context.annotation.Import(SubmissionsWebConfiguration.class)
    static class WebEndpointsConfiguration {
    }

}
