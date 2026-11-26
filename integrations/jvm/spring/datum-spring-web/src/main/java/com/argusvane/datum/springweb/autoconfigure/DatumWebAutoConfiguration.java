package com.argusvane.datum.springweb.autoconfigure;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.core.DatumEventPublisher;
import com.argusvane.datum.core.DatumStartupCheck;
import com.argusvane.datum.core.assets.AssetManifest;
import com.argusvane.datum.core.assets.AssetManifestLoader;
import com.argusvane.datum.core.assets.HostBindings;
import com.argusvane.datum.core.observation.DatumObservations;
import com.argusvane.datum.core.observation.MicrometerObservations;
import com.argusvane.datum.springweb.mvc.DatumMvcExceptionHandler;
import com.argusvane.datum.springweb.mvc.MvcAssetResources;
import com.argusvane.datum.springweb.mvc.MvcAssetRoutes;
import com.argusvane.datum.springweb.spring.DatumBindingsProperties;
import com.argusvane.datum.springweb.spring.DatumProperties;
import com.argusvane.datum.springweb.spring.SpringEventPublisher;
import com.argusvane.datum.springweb.spring.SpringFrameworkErrors;
import com.argusvane.datum.springweb.webflux.DatumMethodNotAllowedMapping;
import com.argusvane.datum.springweb.webflux.DatumMethodRules;
import com.argusvane.datum.springweb.webflux.DatumRouteRegistry;
import com.argusvane.datum.springweb.webflux.DatumWebFluxExceptionHandler;
import com.argusvane.datum.springweb.webflux.WebFluxAssetResources;
import com.argusvane.datum.springweb.webflux.WebFluxAssetRoutes;
import com.argusvane.datum.web.WebSettings;
import com.argusvane.datum.web.assets.AssetService;
import com.argusvane.datum.web.assets.DatumAssets;
import com.argusvane.datum.web.assets.WithheldAssets;
import com.argusvane.datum.web.error.ErrorMapper;
import com.argusvane.datum.web.error.ErrorTranslator;
import com.argusvane.datum.web.json.DatumJsonMapper;
import com.argusvane.datum.web.monitoring.DatumCapabilities;
import com.argusvane.datum.web.monitoring.DatumCapability;
import com.argusvane.datum.web.monitoring.DatumHealthCheck;
import com.argusvane.datum.web.monitoring.DatumHealthContributors;
import com.argusvane.datum.web.monitoring.EnabledRoutesNotice;
import com.argusvane.datum.web.openapi.DatumOpenApiRegistry;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication.Type;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.core.io.ResourceLoader;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;

/**
 * Datum's shared web plumbing: properties, error mapping, the JSON mapper, the assets bean and the versioned
 * asset handler, on whichever web stack the application runs.
 *
 * <p>Gated on {@code datum.enabled}. The stack-specific beans sit in nested configurations conditional on the
 * web application type and on the stack's own classes, so an MVC application never loads a WebFlux class and
 * the reverse. Every bean is {@code @ConditionalOnMissingBean}-free on purpose where the
 * type is Datum's own; an application replaces behaviour through {@link ErrorTranslator} and
 * {@link WithheldAssets} beans.
 */
@AutoConfiguration
@ConditionalOnProperty(prefix = "datum", name = "enabled", matchIfMissing = true)
@EnableConfigurationProperties({DatumProperties.class, DatumBindingsProperties.class})
public final class DatumWebAutoConfiguration {

    private static final Logger LOG = LoggerFactory.getLogger("datum.web");

    /** {@code datum.*} as the libraries read it. */
    @Bean
    @ConditionalOnMissingBean
    WebSettings datumWebSettings(DatumProperties properties) {
        return properties.toSettings();
    }

    /**
     * Runs every capability's {@link DatumStartupCheck} once, after the singletons exist and before the web server
     * takes requests: the words and conditions are the
     * libraries', so a Quarkus application would log the same lines at its start.
     */
    @Bean
    SmartInitializingSingleton datumStartupChecks(ObjectProvider<DatumStartupCheck> checks) {
        return () -> DatumStartupCheck.runAll(checks.orderedStream().toList());
    }

    /**
     * The start-up notice: which Datum routes are on and which switch turned each on, or the sentence that says
     * none is and names the properties. A catalog switch is read from the environment (relaxed names included); the
     * API switches go through {@link WebSettings} so the notice and the route registration cannot disagree.
     */
    @Bean
    DatumStartupCheck datumEnabledRoutesNotice(WebSettings settings, DatumCapabilities capabilities, DatumAssets assets,
                                              Environment environment) {
        String api = "datum.web.api.endpoints.";
        return EnabledRoutesNotice.check(() -> new EnabledRoutesNotice.Facts(settings, capabilities.present(), capabilities.endpoints(),
            assets.enabled(), key -> key.startsWith(api) ? settings.api().endpointEnabled(key.substring(api.length()))
                : environment.getProperty(key, Boolean.class, false)));
    }

    @Bean
    DatumRouteRegistry datumRouteRegistry() {
        return new DatumRouteRegistry();
    }

    @Bean
    DatumMethodRules datumMethodRules() {
        return new DatumMethodRules();
    }

    @Bean
    DatumJsonMapper datumJsonMapper(WebSettings settings) {
        return DatumJsonMapper.create(settings.api().maxBodyBytes());
    }

    @Bean
    ErrorMapper datumErrorMapper(WebSettings settings, ObjectProvider<ErrorTranslator> translators) {
        // The framework's order of the ordered SPIs (@Order, Ordered, @Priority): translators whose relative order matters
        // declare it; equal orders keep registration order.
        return new ErrorMapper(settings.api().problemDetails(), translators.orderedStream().toList(), SpringFrameworkErrors.INSTANCE,
            settings.api().busyRetryAfter());
    }

    /**
     * The capabilities present: every {@link DatumCapability} bean, collected on the first read. A capability
     * declares its own bean, so an application bean that replaces a facade or the runtime keeps the start-up notice,
     * {@code info.datum} and {@code host.json} true.
     */
    @Bean
    DatumCapabilities datumCapabilities(ObjectProvider<DatumCapability> capabilities) {
        return new DatumCapabilities(() -> capabilities.orderedStream().toList());
    }

    /** The health checks: every {@link DatumHealthCheck} bean, collected on the first read. */
    @Bean
    DatumHealthContributors datumHealthContributors(ObjectProvider<DatumHealthCheck> checks) {
        return new DatumHealthContributors(() -> checks.orderedStream().toList());
    }

    /**
     * Where every Datum library publishes its events: Spring's {@link ApplicationEventPublisher} behind
     * {@link DatumEventPublisher#guarded}, so a listener's failure is logged and never the request's. An application bean
     * of this type replaces it (a recording publisher in tests, an outbox) and is used as given: the guard is
     * this default's, so a replacement owns its failure semantics, and one that throws reaches the code that published,
     * after the effect (the submission stored, the token issued), and fails that call. Wrap a replacement in
     * {@link DatumEventPublisher#guarded} for the default's behaviour; an outbox row that must commit with the record is
     * the {@code SubmissionHandler}'s to write, inside the handler's transaction.
     */
    @Bean
    @ConditionalOnMissingBean
    DatumEventPublisher datumEventPublisher(ApplicationEventPublisher events) {
        return DatumEventPublisher.guarded(new SpringEventPublisher(events));
    }

    @Bean
    DatumOpenApiRegistry datumOpenApiRegistry() {
        return new DatumOpenApiRegistry();
    }

    /**
     * The assets bean. A manifest on the classpath (any first-party jar that ships assets) turns the handler
     * on; none turns it off with a WARN, since there is nothing versioned to serve. Jars that disagree on the
     * build id stop startup (the loader's {@code AssetManifestException}).
     */
    @Bean
    DatumAssets datumAssets(WebSettings settings, DatumRouteRegistry routes, Environment environment,
                            ResourceLoader resources) {
        String context = contextPath(environment);
        String assetsRoot = context + settings.assets().path();
        String apiBase = context + settings.api().path();
        // The build-id agreement across asset jars is the library's (AssetManifest.verifyAgreement).
        AssetManifest manifest = AssetManifestLoader.load(resources.getClassLoader());
        boolean serve = settings.assets().enabled();
        if (serve && !manifest.isBuilt()) {
            LOG.warn("No META-INF/datum/manifest.json is on the classpath, so Datum's assets are not served. "
                + "Add datum-ui (or the -ui starter), or remove datum.web.assets.enabled=true.");
            serve = false;
        }
        if (serve) {
            routes.register(settings.assets().path() + "/**");
        }
        return new DatumAssets(serve, manifest.buildId(), assetsRoot, assetsRoot + "/" + manifest.buildId(), apiBase,
            manifest);
    }

    /**
     * Which binding each form route is drawn by and the PDF theme it suggests ({@code datum.bindings.*}): the
     * manifest's catalog plus the entries the application adds. A binding the catalog does not list, or a suggested PDF
     * theme nobody supplies, stops startup.
     */
    @Bean
    HostBindings datumHostBindings(DatumAssets assets, DatumBindingsProperties properties, DatumJsonMapper json) {
        java.util.List<AssetManifest.Binding> registered = new java.util.ArrayList<>();
        properties.catalog().forEach((id, entry) -> registered.add(new AssetManifest.Binding(id, entry.label(),
            entry.pdfTheme() == null || entry.pdfTheme().isBlank() ? null : entry.pdfTheme().strip())));
        java.util.Map<String, tools.jackson.databind.JsonNode> themes = new java.util.LinkedHashMap<>();
        properties.pdfThemes().forEach((id, resource) -> {
            try (java.io.InputStream in = resource.getInputStream()) {
                themes.put(id, json.mapper().readTree(in));
            } catch (java.io.IOException | RuntimeException e) {
                throw new DatumConfigurationException("datum.bindings.pdf-themes." + id,
                    "The PDF theme at " + resource.getDescription() + " cannot be read as JSON.", e);
            }
        });
        return HostBindings.of(assets.manifest(), properties.defaultBinding(), properties.routes(), registered, themes);
    }

    @Bean
    AssetService datumAssetService(DatumAssets assets, WebSettings settings, DatumJsonMapper json,
                                   ObjectProvider<WithheldAssets> withheld, ResourceLoader resources,
                                   DatumCapabilities capabilities, HostBindings bindings) {
        return new AssetService(assets, settings, withheld.orderedStream().toList(), resources.getClassLoader(),
            json.mapper(), capabilities, bindings);
    }

    /** The context or base path the application is mounted under, '' when none. */
    private static String contextPath(Environment environment) {
        String servlet = Optional.ofNullable(environment.getProperty("server.servlet.context-path")).orElse("");
        String reactive = Optional.ofNullable(environment.getProperty("spring.webflux.base-path")).orElse("");
        String path = !servlet.isBlank() ? servlet : reactive;
        path = path.strip();
        while (path.endsWith("/")) {
            path = path.substring(0, path.length() - 1);
        }
        return path.isEmpty() || path.startsWith("/") ? path : "/" + path;
    }

    /**
     * Datum's observations: guest runs, submissions, PDF operations and the
     * in-process timestamp authority's tokens as Micrometer observations on the application's {@code ObservationRegistry},
     * so they appear under the HTTP request's trace and Spring Boot's {@code management.observations.enable.datum...=false}
     * switches them off. Without a registry the bean is {@link DatumObservations#none()} and nothing changes (no
     * observation, no meter, no wrapper around the sandbox). An application bean of this type replaces it. The names are
     * {@code DatumObservationNames}'s, apart from Datum's {@code datum.runs*} meters, which stay as they are.
     */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(name = "io.micrometer.observation.ObservationRegistry")
    static class Observations {

        @Bean
        @ConditionalOnMissingBean
        DatumObservations datumObservations(ObjectProvider<io.micrometer.observation.ObservationRegistry> registry) {
            io.micrometer.observation.ObservationRegistry found = registry.getIfAvailable();
            return found == null ? DatumObservations.none() : MicrometerObservations.of(found);
        }
    }

    /** Spring MVC: the exception advice for {@code @DatumController}s and the asset routes. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.SERVLET)
    @ConditionalOnClass(name = "org.springframework.web.servlet.DispatcherServlet")
    static class Mvc {

        @Bean
        DatumMvcExceptionHandler datumMvcExceptionHandler(ErrorMapper errors, DatumJsonMapper json) {
            return new DatumMvcExceptionHandler(errors, json);
        }

        @Bean
        org.springframework.web.servlet.function.RouterFunction<org.springframework.web.servlet.function.ServerResponse>
            datumMvcAssetRoutes(AssetService service) {
            if (!service.assets().enabled()) {
                return request -> Optional.empty();
            }
            return MvcAssetRoutes.routes(service);
        }

        /** The versioned files: Spring MVC's resource handler behind the Datum gate. */
        @Bean
        MvcAssetResources datumMvcAssetResources(AssetService service) {
            return new MvcAssetResources(service);
        }
    }

    /** WebFlux: the web exception handler for registered Datum routes and the asset routes. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.REACTIVE)
    @ConditionalOnClass(name = "org.springframework.web.reactive.config.WebFluxConfigurer")
    static class Reactive {

        @Bean
        DatumWebFluxExceptionHandler datumWebFluxExceptionHandler(ErrorMapper errors, DatumJsonMapper json,
                                                                  DatumRouteRegistry routes) {
            return new DatumWebFluxExceptionHandler(errors, json, routes);
        }

        /** The 405 answer for a wrong method on a Datum path that nothing else handles (see the class). */
        @Bean
        DatumMethodNotAllowedMapping datumMethodNotAllowedMapping(DatumMethodRules rules) {
            return new DatumMethodNotAllowedMapping(rules);
        }

        @Bean
        org.springframework.web.reactive.function.server.RouterFunction<org.springframework.web.reactive.function.server.ServerResponse>
            datumWebFluxAssetRoutes(AssetService service) {
            if (!service.assets().enabled()) {
                return request -> reactor.core.publisher.Mono.empty();
            }
            return WebFluxAssetRoutes.routes(service);
        }

        /** The versioned files: WebFlux's resource handler behind the Datum gate. */
        @Bean
        WebFluxAssetResources datumWebFluxAssetResources(AssetService service, ObjectProvider<Scheduler> scheduler) {
            return new WebFluxAssetResources(service, scheduler.getIfUnique(Schedulers::boundedElastic));
        }
    }
}
