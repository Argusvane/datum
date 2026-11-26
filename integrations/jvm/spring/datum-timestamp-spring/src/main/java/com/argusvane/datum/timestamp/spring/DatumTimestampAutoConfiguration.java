package com.argusvane.datum.timestamp.spring;

import com.argusvane.datum.core.observation.DatumObservations;
import com.argusvane.datum.core.DatumEventPublisher;
import com.argusvane.datum.core.DatumStartupCheck;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import com.argusvane.datum.springweb.spring.DatumRouteBase;
import com.argusvane.datum.springweb.spring.ConditionalOnDatumDataSource;
import com.argusvane.datum.springweb.spring.DatumDataSource;
import com.argusvane.datum.springweb.spring.DatumDataSources;
import com.argusvane.datum.springweb.spring.DatumStoreJdbc;
import com.argusvane.datum.springweb.spring.JdbcSchemaInitializer;
import com.argusvane.datum.springweb.spring.SpringResources;
import com.argusvane.datum.springweb.spring.SpringEventPublisher;
import com.argusvane.datum.timestamp.InMemoryTsaLog;
import com.argusvane.datum.springweb.spring.SigningBundles;
import com.argusvane.datum.timestamp.KeyStoreTsaKeyMaterial;
import com.argusvane.datum.timestamp.SelfSignedTsaCertificate;
import com.argusvane.datum.timestamp.TimestampAuthority;
import com.argusvane.datum.timestamp.TimestampRequestCustomizer;
import com.argusvane.datum.timestamp.TsaClientStore;
import com.argusvane.datum.timestamp.TsaKey;
import com.argusvane.datum.timestamp.TsaKeyException;
import com.argusvane.datum.timestamp.TsaKeyMaterial;
import com.argusvane.datum.timestamp.TsaLog;
import com.argusvane.datum.timestamp.TsaSerialAllocator;
import com.argusvane.datum.timestamp.TsaTimeSource;
import com.argusvane.datum.timestamp.web.PropertiesTsaClientStore;
import com.argusvane.datum.timestamp.web.TsaCertificates;
import com.argusvane.datum.timestamp.web.TsaEndpoint;
import com.argusvane.datum.timestamp.web.TsaFlood;
import com.argusvane.datum.timestamp.web.TsaHealth;
import com.argusvane.datum.timestamp.web.TsaRoutes;
import com.argusvane.datum.timestamp.web.TsaSettings;
import com.argusvane.datum.timestamp.web.mvc.TsaMvcController;
import com.argusvane.datum.timestamp.web.webflux.TsaWebFluxHandlers;
import com.argusvane.datum.springweb.webflux.DatumMethodRules;
import com.argusvane.datum.springweb.webflux.DatumRouteRegistry;
import com.argusvane.datum.web.monitoring.DatumCapability;
import com.argusvane.datum.web.monitoring.DatumHealthCheck;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.enums.ParameterIn;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.parameters.RequestBody;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.cert.X509Certificate;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import javax.sql.DataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springdoc.core.annotations.RouterOperation;
import org.springdoc.core.annotations.RouterOperations;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication.Type;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.ssl.SslBundles;
import org.springframework.boot.sql.init.dependency.DependsOnDatabaseInitialization;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.Resource;
import org.springframework.core.io.ResourceLoader;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;

/**
 * The timestamp server on Spring Boot: the RFC 3161 authority, its endpoints on MVC or WebFlux, JDBC stores,
 * health, events and OpenAPI.
 *
 * <p>Off unless {@code datum.tsa.enabled=true}: a host that does not ask has none of these beans and the paths are
 * the application's own (404). Every bean is replaceable by an application bean of the same type. Serial numbers
 * come from the {@code datum_tsa_log} table when the application has one {@code DataSource}; without it they
 * come from memory only when {@code datum.tsa.allow-memory-stores=true} acknowledges it (otherwise the start
 * fails, naming the migration); the start then says so in a WARN: serials are unique only per host, which a server
 * whose tokens are kept must not accept. The signing key comes from
 * {@code datum.tsa.signer.*} (a key store) or, for development, a self-signed certificate.
 */
@AutoConfiguration(after = DatumWebAutoConfiguration.class, afterName = {
    "org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration",
    "org.springframework.boot.jdbc.autoconfigure.JdbcTemplateAutoConfiguration"
})
@ConditionalOnProperty(prefix = "datum", name = "enabled", matchIfMissing = true)
@ConditionalOnProperty(prefix = "datum.tsa", name = "enabled", havingValue = "true")
@EnableConfigurationProperties(DatumTsaProperties.class)
public final class DatumTimestampAutoConfiguration {

    private static final Logger LOG = LoggerFactory.getLogger("datum.tsa");

    /**
     * JDBC serials, log and (when asked for) clients, with the application's one {@code DataSource} and Spring's JDBC.
     * Each store call is a transaction of its own under the
     * application's transaction manager when that is its only one and a JDBC manager of the data source
     * ({@link DatumStoreJdbc}), so a serial is committed before the token is signed and survives any transaction the caller
     * rolls back.
     */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass({DataSource.class, JdbcClient.class})
    @ConditionalOnDatumDataSource
    static class Jdbc {

        // Each store asks for the data source marked @DatumDataSource, else the single or primary one, and for
        // the module's tables to be made when datum.jdbc.initialize-schema asks and they are missing; the script makes all
        // three tables, so the second and third find the first and run nothing.

        @Bean
        @ConditionalOnMissingBean(TsaSerialAllocator.class)
        @DependsOnDatabaseInitialization
        JdbcTsaSerialAllocator datumJdbcTsaSerialAllocator(@DatumDataSource ObjectProvider<DataSource> datumDataSource,
                                                           ObjectProvider<DataSource> dataSource, ObjectProvider<JdbcSchemaInitializer> schema,
                                                           ObjectProvider<PlatformTransactionManager> transactions, ObjectProvider<Clock> clock) {
            DataSource chosen = DatumDataSources.prepare(datumDataSource, dataSource, schema, JdbcSchemaInitializer.Schema.TIMESTAMP);
            return new JdbcTsaSerialAllocator(DatumStoreJdbc.forApplication(chosen, transactions), clock.getIfAvailable(Clock::systemUTC));
        }

        @Bean
        @ConditionalOnBean(JdbcTsaSerialAllocator.class)
        @ConditionalOnMissingBean(TsaLog.class)
        @DependsOnDatabaseInitialization
        JdbcTsaLog datumJdbcTsaLog(@DatumDataSource ObjectProvider<DataSource> datumDataSource, ObjectProvider<DataSource> dataSource,
                                   ObjectProvider<JdbcSchemaInitializer> schema, ObjectProvider<PlatformTransactionManager> transactions) {
            DataSource chosen = DatumDataSources.prepare(datumDataSource, dataSource, schema, JdbcSchemaInitializer.Schema.TIMESTAMP);
            return new JdbcTsaLog(DatumStoreJdbc.forApplication(chosen, transactions));
        }

        @Bean
        @ConditionalOnProperty(prefix = "datum.tsa", name = "client-store", havingValue = "jdbc")
        @ConditionalOnMissingBean(TsaClientStore.class)
        @DependsOnDatabaseInitialization
        JdbcTsaClientStore datumJdbcTsaClientStore(@DatumDataSource ObjectProvider<DataSource> datumDataSource,
                                                   ObjectProvider<DataSource> dataSource, ObjectProvider<JdbcSchemaInitializer> schema,
                                                   ObjectProvider<PlatformTransactionManager> transactions, ObjectProvider<Clock> clock) {
            DataSource chosen = DatumDataSources.prepare(datumDataSource, dataSource, schema, JdbcSchemaInitializer.Schema.TIMESTAMP);
            return new JdbcTsaClientStore(DatumStoreJdbc.forApplication(chosen, transactions), clock.getIfAvailable(Clock::systemUTC));
        }
    }

    /**
     * The in-memory fallback: serials seeded from the clock (the start-up check below WARNs about it). Refused unless
     * {@code datum.tsa.allow-memory-stores=true}: a memory store is one per process,
     * so a second instance would not share it, as the passkey stores in datum-webauthn-spring.
     */
    @Bean
    @ConditionalOnMissingBean(TsaSerialAllocator.class)
    InMemoryTsaLog datumInMemoryTsaLog(TsaSettings settings, ObjectProvider<Clock> clock) {
        settings.acknowledgeMemoryStore("serial allocator (datum_tsa_log)",
            "serials are seeded from the clock and unique only within this host, so a second instance, a restart after the clock was set back "
                + "or more than 1000 tokens a millisecond could repeat one (RFC 3161 section 2.4.2)");
        return new InMemoryTsaLog(clock.getIfAvailable(Clock::systemUTC));
    }

    /**
     * The WARN for serials that come from memory: the library's start-up check, run once
     * every bean exists by datum-spring-web's runner.
     */
    @Bean
    DatumStartupCheck datumTsaSerialsStartupCheck(ObjectProvider<TsaSerialAllocator> allocators) {
        // Any in-memory allocator in the context is reported, not only a unique one: two allocators would otherwise fall silent.
        return () -> allocators.orderedStream().filter(InMemoryTsaLog.class::isInstance).findFirst()
            .map(memory -> InMemoryTsaLog.startupCheck(memory).check()).orElse(java.util.List.of());
    }

    /** {@code datum.tsa.*} as the library reads it. */
    @Bean
    @ConditionalOnMissingBean
    TsaSettings datumTsaSettings(DatumTsaProperties properties) {
        return properties.toSettings();
    }

    @Bean
    @ConditionalOnMissingBean(TsaClientStore.class)
    PropertiesTsaClientStore datumPropertiesTsaClientStore(TsaSettings settings) {
        PropertiesTsaClientStore store = new PropertiesTsaClientStore(settings.clients());
        if (settings.access() == TsaSettings.Access.CLIENTS && store.size() == 0) {
            LOG.warn("datum.tsa.access is clients but datum.tsa.clients is empty: every request will be answered 401. "
                + "List the SHA-256 of each client key (TsaClientKeys.hash), set datum.tsa.client-store=jdbc, or set access=open.");
        }
        return store;
    }

    @Bean
    @ConditionalOnMissingBean
    TsaFlood datumTsaFlood(ObjectProvider<Clock> clock) {
        LOG.warn("Datum: the timestamp server's request counter is in memory: each application instance counts on its own. "
            + "Supply a TsaFlood bean for one limit across instances (docs/spring.md, Rate limiting).");
        return new InMemoryTsaFlood(clock.getIfAvailable(Clock::systemUTC));
    }

    @Bean
    @ConditionalOnMissingBean
    TsaKeyMaterial datumTsaKeyMaterial(TsaSettings settings, DatumTsaProperties properties, ObjectProvider<Clock> clock,
                                       ObjectProvider<SslBundles> bundles) {
        TsaSettings.Signer signer = settings.signer();
        String bundle = properties.getSigner().getSslBundle();
        if (bundle != null && signer.selfSigned()) {
            throw new IllegalStateException("Set only one of datum.tsa.signer.ssl-bundle and datum.tsa.signer.self-signed, not both.");
        }
        if (bundle != null) {
            SigningBundles.Lookup found = SigningBundles.key(bundles, bundle, "datum.tsa.signer.ssl-bundle");
            if (found.problem() != null) {
                throw new TsaKeyException(found.problem());
            }
            SigningBundles.Key key = found.key();
            return new KeyStoreTsaKeyMaterial(key.store(), key.alias(), key.password(), clock.getIfAvailable(Clock::systemUTC));
        }
        if (signer.selfSigned()) {
            LOG.warn("datum.tsa.signer.self-signed is on: the timestamp server signs with a throw-away certificate made now, which no client "
                + "trusts and which changes at every start. Development only; set datum.tsa.signer.ssl-bundle for anything else.");
            TsaKey key = SelfSignedTsaCertificate.create("Datum development timestamp server");
            return TsaKeyMaterial.of(key);
        }
        LOG.warn("The timestamp server has no signing key (datum.tsa.signer.ssl-bundle is empty): every request will be answered with a "
            + "systemFailure refusal and datum-tsa health is DOWN.");
        return () -> {
            throw new TsaKeyException("The site has no timestamp server certificate.");
        };
    }

    /**
     * Where the server gets its time: the application's {@link Clock} bean (the system clock without one), always
     * available. An application that must stop issuing when the clock is not trustworthy supplies its own
     * {@link TsaTimeSource} bean.
     */
    @Bean
    @ConditionalOnMissingBean
    TsaTimeSource datumTsaTimeSource(ObjectProvider<Clock> clock) {
        return TsaTimeSource.of(clock.getIfAvailable(Clock::systemUTC));
    }

    /**
     * The authority. The application's {@link TimestampRequestCustomizer} beans, in the framework's order
     * ({@code @Order}; equal orders keep registration order), run for every token before it is signed. Each token asked of
     * it is a {@code datum.tsa.issue} observation when the application has an {@code ObservationRegistry} (the
     * {@link DatumObservations} bean of datum-spring-web), under the HTTP request's or the seal's; none without one.
     */
    @Bean
    @ConditionalOnMissingBean
    TimestampAuthority datumTimestampAuthority(TsaKeyMaterial keys, TsaSerialAllocator serials, TsaSettings settings,
                                               TsaTimeSource time, ObjectProvider<TimestampRequestCustomizer> customizers,
                                               ObjectProvider<DatumObservations> observations) {
        return new TimestampAuthority(keys, settings.policy(), settings.accuracy(), time, serials, settings.acceptedPolicies(),
            customizers.orderedStream().toList(), observations.getIfAvailable(DatumObservations::none));
    }

    @Bean
    @ConditionalOnMissingBean
    TsaCertificates datumTsaCertificates(TsaKeyMaterial keys, TsaSettings settings, ResourceLoader resources) {
        List<List<X509Certificate>> retired = new ArrayList<>();
        for (String location : settings.retiredCertificates()) {
            retired.add(TsaCertificates.parsePem(read(resources, location)));
        }
        return new TsaCertificates(keys, retired);
    }

    @Bean(name = TsaRoutes.BEAN_NAME)
    TsaRoutes datumTsaRoutes(TsaSettings settings) {
        return new TsaRoutes(settings);
    }

    /**
     * The base the routes are mapped under, for datum-spring-web's security matchers: from the routes bean, so
     * an application's own {@link TsaSettings} bean with another path moves {@code datum.tsa()} with the routes rather than
     * leaving the application's rule on {@code datum.tsa.path}. Its access too, for the start-up security WARN:
     * open routes need no chain, and the settings bean, not {@code datum.tsa.access}, says whether they are.
     */
    @Bean
    DatumRouteBase datumTsaRouteBase(TsaRoutes routes, TsaSettings settings) {
        return new DatumRouteBase(DatumEndpointCatalog.Base.TSA, routes.path(), settings.access() == TsaSettings.Access.OPEN);
    }

    @Bean
    @ConditionalOnMissingBean
    TsaEndpoint datumTsaEndpoint(TimestampAuthority authority, TsaClientStore clients, TsaFlood flood, TsaCertificates certificates,
                                 TsaSettings settings, ObjectProvider<DatumEventPublisher> publisher, ApplicationEventPublisher events,
                                 org.springframework.core.env.Environment environment) {
        // An application that renames its session cookie is still refused, on either stack: Spring Boot names
        // the servlet one server.servlet.session.cookie.name and the WebFlux one server.reactive.session.cookie.name.
        java.util.Set<String> extra = new java.util.LinkedHashSet<>();
        for (String key : SESSION_COOKIE_NAMES) {
            String renamed = environment.getProperty(key);
            if (renamed != null && !renamed.isBlank()) {
                extra.add(renamed.strip());
            }
        }
        return new TsaEndpoint(authority, clients, flood, certificates, settings, SpringEventPublisher.of(publisher, events), extra);
    }

    /** Spring Boot's session-cookie name properties: the servlet stack's, then WebFlux's. */
    static final List<String> SESSION_COOKIE_NAMES = List.of("server.servlet.session.cookie.name", "server.reactive.session.cookie.name");

    /** The {@code datum-tsa} check's state: the key, the clock, the serial allocator and the access. Replaceable. */
    @Bean
    @ConditionalOnMissingBean
    TsaHealth datumTsaHealth(TsaKeyMaterial keys, TsaSerialAllocator serials, TsaSettings settings, TsaTimeSource time) {
        String allocator = serials instanceof JdbcTsaSerialAllocator ? "jdbc" : serials instanceof InMemoryTsaLog ? "memory" : "custom";
        return new TsaHealth(keys, time, allocator, settings.access().name().toLowerCase(java.util.Locale.ROOT));
    }

    /** The {@code datum-tsa} health check ({@code datum/datum-tsa}), over the {@link TsaHealth} bean. */
    @Bean
    DatumHealthCheck datumTsaHealthCheck(TsaHealth health) {
        return DatumHealthCheck.of(TsaHealth.NAME, health::status);
    }

    /** The {@code timestamp} capability and its endpoint base for {@code host.json}, from the routes bean. */
    @Bean
    DatumCapability datumTimestampCapability(TsaRoutes routes) {
        return DatumCapability.of("timestamp").withEndpoint("tsa", routes.path());
    }

    /** A Spring resource location, or a plain file path: the one rule the PDF module reads this module's locations with too. */
    private static Resource resource(ResourceLoader resources, String location) {
        return SpringResources.location(resources, location);
    }

    private static String read(ResourceLoader resources, String location) {
        try (InputStream in = resource(resources, location).getInputStream()) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new TsaKeyException("A retired timestamp certificate file " + location + " cannot be read: " + e.getMessage(), e);
        }
    }

    /** Spring MVC: the controller. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.SERVLET)
    @ConditionalOnClass(name = "org.springframework.web.servlet.DispatcherServlet")
    static class Mvc {

        @Bean
        TsaMvcController datumTsaController(TsaEndpoint endpoint) {
            return new TsaMvcController(endpoint);
        }
    }

    /** WebFlux: one router function. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.REACTIVE)
    @ConditionalOnClass(name = "org.springframework.web.reactive.config.WebFluxConfigurer")
    static class Reactive {

        // Springdoc reads annotation values literally, so the operations are annotated at the default path;
        // DatumTimestampOpenApiAutoConfiguration moves the document's path keys to the configured datum.tsa.path.
        private static final String PATH = "/tsa";
        private static final String TEXT = "text/plain";

        /** A bean, because springdoc looks the handler class up in the context to read the operation's method. */
        @Bean
        TsaWebFluxHandlers datumTsaHandlers(TsaEndpoint endpoint, ObjectProvider<Scheduler> scheduler) {
            return new TsaWebFluxHandlers(endpoint, scheduler.getIfUnique(Schedulers::boundedElastic));
        }

        @Bean
        @RouterOperations({
            @RouterOperation(path = PATH, method = org.springframework.web.bind.annotation.RequestMethod.POST,
                beanClass = TsaWebFluxHandlers.class, beanMethod = "issue",
                operation = @Operation(operationId = "issueTimestamp", summary = "Issue an RFC 3161 timestamp token", tags = "datum-tsa",
                    description = "Takes a TimeStampReq (DER) and answers a TimeStampResp (DER): 200 with a token, 400 when the request is refused "
                        + "and 503 when the server cannot issue one; both carry a PKIFailureInfo and a statusString. A client key is sent as a "
                        + "bearer token or as the password of HTTP Basic authentication.",
                    requestBody = @RequestBody(required = true, description = "A TimeStampReq, DER.",
                        content = @Content(mediaType = "application/timestamp-query", schema = @Schema(type = "string", format = "binary"))),
                    responses = {
                        @ApiResponse(responseCode = "200", description = "A TimeStampResp with a granted token.",
                            content = @Content(mediaType = "application/timestamp-reply", schema = @Schema(type = "string", format = "binary"))),
                        @ApiResponse(responseCode = "400", description = "A TimeStampResp with status rejection (the request is at fault).",
                            content = @Content(mediaType = "application/timestamp-reply", schema = @Schema(type = "string", format = "binary"))),
                        @ApiResponse(responseCode = "401", description = "A client key is needed (text/plain); WWW-Authenticate names Bearer and Basic.",
                            content = @Content(mediaType = TEXT, schema = @Schema(type = "string"))),
                        @ApiResponse(responseCode = "403", description = "The request carries a browser session cookie (text/plain).",
                            content = @Content(mediaType = TEXT, schema = @Schema(type = "string"))),
                        @ApiResponse(responseCode = "413", description = "The request is larger than datum.tsa.max-request-size (text/plain).",
                            content = @Content(mediaType = TEXT, schema = @Schema(type = "string"))),
                        @ApiResponse(responseCode = "415", description = "The Content-Type is not application/timestamp-query (text/plain).",
                            content = @Content(mediaType = TEXT, schema = @Schema(type = "string"))),
                        @ApiResponse(responseCode = "429", description = "Too many requests, or too many wrong keys from this address (text/plain).",
                            content = @Content(mediaType = TEXT, schema = @Schema(type = "string"))),
                        @ApiResponse(responseCode = "503", description = "A TimeStampResp: the server cannot issue a token now.",
                            content = @Content(mediaType = "application/timestamp-reply", schema = @Schema(type = "string", format = "binary")))})),
            @RouterOperation(path = PATH + "/certificate", method = org.springframework.web.bind.annotation.RequestMethod.GET,
                beanClass = TsaWebFluxHandlers.class, beanMethod = "certificate",
                operation = @Operation(operationId = "getTimestampCertificate", summary = "The certificate tokens are signed with now", tags = "datum-tsa",
                    description = "The chain as PEM, the server's own certificate first; format=der answers that certificate alone. Public: a verifier needs it.",
                    parameters = @Parameter(name = "format", in = ParameterIn.QUERY, description = "der for the server's certificate alone.",
                        schema = @Schema(type = "string", allowableValues = "der")),
                    responses = {
                        @ApiResponse(responseCode = "200", description = "The certificate.", content = {
                            @Content(mediaType = "application/pem-certificate-chain", schema = @Schema(type = "string")),
                            @Content(mediaType = "application/pkix-cert", schema = @Schema(type = "string", format = "binary"))}),
                        @ApiResponse(responseCode = "503", description = "The server has no certificate it can use (text/plain).",
                            content = @Content(mediaType = TEXT, schema = @Schema(type = "string")))})),
            @RouterOperation(path = PATH + "/certificates", method = org.springframework.web.bind.annotation.RequestMethod.GET,
                beanClass = TsaWebFluxHandlers.class, beanMethod = "certificates",
                operation = @Operation(operationId = "getTimestampCertificates", summary = "Every certificate the server has signed with", tags = "datum-tsa",
                    description = "The one in use first, then the retired ones, each chain as PEM after comment lines naming it. Public.",
                    responses = {
                        @ApiResponse(responseCode = "200", description = "The certificates.",
                            content = @Content(mediaType = "application/x-pem-file", schema = @Schema(type = "string"))),
                        @ApiResponse(responseCode = "503", description = "The server has no certificate (text/plain).",
                            content = @Content(mediaType = TEXT, schema = @Schema(type = "string")))}))})
        RouterFunction<ServerResponse> datumTsaRouterFunction(TsaRoutes routes, TsaWebFluxHandlers handlers, DatumRouteRegistry registry,
                                                              DatumMethodRules methods) {
            registry.register(routes.routes().toArray(String[]::new));
            RouterFunctions.Builder router = RouterFunctions.route()
                .POST(routes.path(), handlers::issue)
                .GET(routes.certificatePath(), handlers::certificate).HEAD(routes.certificatePath(), handlers::certificate)
                .GET(routes.certificatesPath(), handlers::certificates).HEAD(routes.certificatesPath(), handlers::certificates);
            // A wrong method answers 405 as MVC does, from the shared method rules (DatumMethodNotAllowedMapping in
            // datum-spring-web, asked only when no controller and no router claimed the request): not a path-wide
            // route here, which would take the path from an application's own controller or router on it and write
            // the 405 itself (forms and the builder work the same way).
            methods.allow(routes.path(), "POST");
            methods.allow(routes.certificatePath(), "GET", "HEAD");
            methods.allow(routes.certificatesPath(), "GET", "HEAD");
            return router.build();
        }
    }
}
