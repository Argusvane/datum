package com.argusvane.datum.springweb.autoconfigure;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.core.DatumEventPublisher;
import com.argusvane.datum.core.assets.HostBindings;
import com.argusvane.datum.web.assets.AssetService;
import tools.jackson.databind.JsonNode;
import com.argusvane.datum.springweb.mvc.DatumMvcExceptionHandler;
import com.argusvane.datum.springweb.spring.DatumHealthContributor;
import com.argusvane.datum.springweb.spring.DatumInfoContributor;
import com.argusvane.datum.springweb.spring.DatumProperties;
import com.argusvane.datum.springweb.webflux.DatumWebFluxExceptionHandler;
import com.argusvane.datum.springweb.webflux.DatumRouteRegistry;
import com.argusvane.datum.web.assets.DatumAssets;
import com.argusvane.datum.web.error.ErrorMapper;
import com.argusvane.datum.web.json.DatumJsonMapper;
import com.argusvane.datum.web.monitoring.DatumCapabilities;
import com.argusvane.datum.web.monitoring.DatumCapability;
import com.argusvane.datum.web.monitoring.DatumHealthCheck;
import com.argusvane.datum.web.monitoring.DatumHealthContributors.Status;
import com.argusvane.datum.web.monitoring.DatumMeters;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.Duration;
import java.util.Map;
import org.junit.jupiter.api.Test;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.boot.actuate.info.Info;
import org.springframework.boot.health.contributor.CompositeHealthContributor;
import org.springframework.boot.health.actuate.endpoint.CompositeHealthDescriptor;
import org.springframework.boot.health.actuate.endpoint.HealthDescriptor;
import org.springframework.boot.health.actuate.endpoint.HealthEndpoint;
import org.springframework.boot.health.autoconfigure.actuate.endpoint.HealthEndpointAutoConfiguration;
import org.springframework.boot.health.autoconfigure.contributor.HealthContributorAutoConfiguration;
import org.springframework.boot.health.autoconfigure.registry.HealthContributorRegistryAutoConfiguration;
import org.springframework.boot.health.contributor.HealthContributor;
import org.springframework.boot.health.contributor.HealthIndicator;
import org.springframework.context.ApplicationListener;
import org.springframework.context.PayloadApplicationEvent;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.FilteredClassLoader;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.test.context.runner.ReactiveWebApplicationContextRunner;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.core.io.ClassPathResource;
import org.springframework.web.reactive.config.WebFluxConfigurer;
import org.springframework.web.servlet.DispatcherServlet;

class DatumAutoConfigurationTest {

    private static final AutoConfigurations ALL = AutoConfigurations.of(DatumWebAutoConfiguration.class,
        DatumOpenApiAutoConfiguration.class, DatumActuatorAutoConfiguration.class, DatumMetricsAutoConfiguration.class);

    @Test
    void theSharedBeansExistWithoutAnyWebApplication() {
        new ApplicationContextRunner().withConfiguration(ALL).withPropertyValues("datum.web.assets.enabled=true").run(context -> {
            assertThat(context).hasSingleBean(DatumProperties.class).hasSingleBean(ErrorMapper.class)
                .hasSingleBean(DatumRouteRegistry.class).hasSingleBean(DatumJsonMapper.class)
                .hasSingleBean(DatumCapabilities.class).hasSingleBean(DatumAssets.class);
            // Datum's mapper is a holder, not a JsonMapper: Boot's own mapper is untouched.
            assertThat(context).doesNotHaveBean(tools.jackson.databind.json.JsonMapper.class);
            DatumAssets assets = context.getBean(DatumAssets.class);
            assertThat(assets.enabled()).isTrue();
            assertThat(assets.buildId()).isEqualTo("testbuild1");
            assertThat(assets.assetUrl("datum-form.js")).isEqualTo("/datum/assets/testbuild1/datum-form.js");
            assertThat(context.getBean(DatumRouteRegistry.class).matches("/datum/assets/testbuild1/x.js")).isTrue();
            assertThat(context.getBean(DatumRouteRegistry.class).matches("/api/anything")).as("only registered routes").isFalse();
            assertThat(context).doesNotHaveBean(DatumMvcExceptionHandler.class).doesNotHaveBean(DatumWebFluxExceptionHandler.class);
        });
    }

    @Test
    void aHostThatSetNothingDrawsEveryRouteWithDatumAndPublishesTheTableInHostJson() {
        new ApplicationContextRunner().withConfiguration(ALL).withPropertyValues("datum.web.assets.enabled=true").run(context -> {
            HostBindings bindings = context.getBean(HostBindings.class);
            assertThat(bindings.bindingOf("contact")).isEqualTo("datum");
            assertThat(bindings.pdfThemeId("contact")).isEqualTo("datum-pdf");
            JsonNode host = JSON.readTree(context.getBean(AssetService.class).hostJson());
            assertThat(host.get("bindings").get("default").asString()).isEqualTo("datum");
            assertThat(host.get("bindings").get("routes")).isEmpty();
        });
    }

    @Test
    void datumBindingsSetsTheDefaultAndPerRouteOverridesAndTheCatalogEntriesAHostAdds() {
        new ApplicationContextRunner().withConfiguration(ALL).withPropertyValues("datum.web.assets.enabled=true",
            "datum.bindings.default=datum",
            "datum.bindings.routes.benefits=ledger",
            "datum.bindings.catalog.ledger.label=Ledger",
            "datum.bindings.catalog.ledger.pdf-theme=ledger",
            "datum.bindings.pdf-themes.ledger=classpath:/datum-bindings/ledger-pdf.json").run(context -> {
                HostBindings bindings = context.getBean(HostBindings.class);
                assertThat(bindings.pdfThemeId("benefits")).isEqualTo("ledger");
                assertThat(bindings.pdfTheme("benefits").path("label").asString()).isEqualTo("Ledger");
                assertThat(bindings.pdfThemeId("contact")).isEqualTo("datum-pdf");
                JsonNode host = JSON.readTree(context.getBean(AssetService.class).hostJson());
                assertThat(host.get("bindings").get("routes").get("benefits").asString()).isEqualTo("ledger");
            });
    }

    @Test
    void aBindingTheCatalogDoesNotListOrAPdfThemeNobodySuppliesStopsStartup() {
        new ApplicationContextRunner().withConfiguration(ALL).withPropertyValues("datum.bindings.routes.benefits=nope").run(context -> {
            assertThat(context).hasFailed();
            assertThat(rootCause(context.getStartupFailure())).isInstanceOf(DatumConfigurationException.class)
                .hasMessageContaining("'nope'");
        });
        new ApplicationContextRunner().withConfiguration(ALL).withPropertyValues("datum.bindings.default=ledger",
            "datum.bindings.catalog.ledger.pdf-theme=ledger").run(context -> {
                assertThat(context).hasFailed();
                assertThat(rootCause(context.getStartupFailure())).hasMessageContaining("does not supply");
            });
    }

    private static Throwable rootCause(Throwable failure) {
        Throwable cause = failure;
        while (cause.getCause() != null) {
            cause = cause.getCause();
        }
        return cause;
    }

    private static final tools.jackson.databind.json.JsonMapper JSON = tools.jackson.databind.json.JsonMapper.builder().build();

    @Test
    void datumEnabledFalseTurnsEverythingOff() {
        new ApplicationContextRunner().withConfiguration(ALL).withPropertyValues("datum.enabled=false")
            .run(context -> assertThat(context).doesNotHaveBean(ErrorMapper.class).doesNotHaveBean(DatumAssets.class)
                .doesNotHaveBean("datumHealthIndicator").doesNotHaveBean(DatumEventPublisher.class).doesNotHaveBean(DatumMeters.class));
    }

    @Test
    void anAbsentManifestSwitchesAssetsOffAndTheContextStillStarts() {
        new ApplicationContextRunner().withConfiguration(ALL).withPropertyValues("datum.web.assets.enabled=true")
            .withClassLoader(new FilteredClassLoader(new ClassPathResource("META-INF/datum/manifest.json")))
            .run(context -> {
                assertThat(context).hasNotFailed();
                DatumAssets assets = context.getBean(DatumAssets.class);
                assertThat(assets.enabled()).isFalse();
                assertThat(assets.buildId()).isEqualTo("dev");
                assertThat(context.getBean(DatumRouteRegistry.class).matches("/datum/assets/dev/x.js")).isFalse();
            });
    }

    @Test
    void assetsSwitchedOffByPropertyAndPathsFollowTheContextPath() {
        // Off with nothing set, and off when set so.
        new ApplicationContextRunner().withConfiguration(ALL)
            .run(context -> assertThat(context.getBean(DatumAssets.class).enabled()).isFalse());
        new ApplicationContextRunner().withConfiguration(ALL).withPropertyValues("datum.web.assets.enabled=false")
            .run(context -> assertThat(context.getBean(DatumAssets.class).enabled()).isFalse());
        new ApplicationContextRunner().withConfiguration(ALL)
            .withPropertyValues("datum.web.assets.enabled=true", "server.servlet.context-path=/shop/", "datum.web.assets.path=static/datum", "datum.web.api.path=/v1")
            .run(context -> {
                DatumAssets assets = context.getBean(DatumAssets.class);
                assertThat(assets.assetsRoot()).isEqualTo("/shop/static/datum");
                assertThat(assets.assetsBase()).isEqualTo("/shop/static/datum/testbuild1");
                assertThat(assets.apiBase()).isEqualTo("/shop/v1");
                // The registry matches paths within the application, without the context path.
                assertThat(context.getBean(DatumRouteRegistry.class).matches("/static/datum/testbuild1/a.js")).isTrue();
            });
    }

    /** The start-up notice says that nothing is on, then lists what the switches turned on. */
    @Test
    void theStartupNoticeNamesTheEnabledRoutesOrSaysNoneIs() {
        new ApplicationContextRunner().withConfiguration(ALL).run(context -> {
            var notices = context.getBean("datumEnabledRoutesNotice", com.argusvane.datum.core.DatumStartupCheck.class).check();
            assertThat(notices).hasSize(1);
            assertThat(notices.get(0).level()).isEqualTo(com.argusvane.datum.core.DatumStartupCheck.Level.INFO);
            assertThat(notices.get(0).message()).contains("no Datum route is enabled").contains("datum.web.api.endpoints.*");
        });
        new ApplicationContextRunner().withConfiguration(ALL).withPropertyValues("datum.web.assets.enabled=true").run(context -> {
            var notices = context.getBean("datumEnabledRoutesNotice", com.argusvane.datum.core.DatumStartupCheck.class).check();
            assertThat(notices.get(0).message()).contains("GET /datum/assets/** (datum.web.assets.enabled)")
                .doesNotContain("no Datum route");
        });
    }

    @Test
    void theServletAdapterLoadsOnlyOnAServletApplicationWithMvcOnTheClasspath() {
        new WebApplicationContextRunner().withConfiguration(ALL).run(context ->
            assertThat(context).hasSingleBean(DatumMvcExceptionHandler.class).doesNotHaveBean(DatumWebFluxExceptionHandler.class));
        new WebApplicationContextRunner().withConfiguration(ALL).withClassLoader(new FilteredClassLoader(DispatcherServlet.class))
            .run(context -> assertThat(context).hasNotFailed().doesNotHaveBean(DatumMvcExceptionHandler.class));
    }

    @Test
    void theReactiveAdapterLoadsOnlyOnAReactiveApplicationWithWebFluxOnTheClasspath() {
        new ReactiveWebApplicationContextRunner().withConfiguration(ALL).run(context ->
            assertThat(context).hasSingleBean(DatumWebFluxExceptionHandler.class).doesNotHaveBean(DatumMvcExceptionHandler.class));
        new ReactiveWebApplicationContextRunner().withConfiguration(ALL).withClassLoader(new FilteredClassLoader(WebFluxConfigurer.class))
            .run(context -> assertThat(context).hasNotFailed().doesNotHaveBean(DatumWebFluxExceptionHandler.class));
    }

    @Test
    void springdocAndActuatorAreOptional() {
        new ApplicationContextRunner().withConfiguration(ALL)
            .withClassLoader(new FilteredClassLoader("org.springdoc", "org.springframework.boot.health", "org.springframework.boot.actuate", "io.micrometer"))
            .run(context -> {
                assertThat(context).hasNotFailed().hasSingleBean(ErrorMapper.class);
                assertThat(context).doesNotHaveBean("datumHealthIndicator").doesNotHaveBean(DatumInfoContributor.class)
                    .doesNotHaveBean(DatumMeters.class);
            });
    }

    /**
     * {@code datum} is a composite with one member per {@link DatumHealthCheck} bean, so a health group
     * can include {@code datum/runtime} alone and each member is UP or DOWN on its own, with its details (the group itself,
     * through Boot's health endpoint, is {@link #aHealthGroupIncludesOneDatumMember}).
     */
    @Test
    void theDatumHealthIsACompositeOfTheCheckBeans() {
        new ApplicationContextRunner().withConfiguration(ALL)
            .withBean("runtimeCheck", DatumHealthCheck.class, () -> DatumHealthCheck.of("runtime", () -> Status.up(Map.of("slots", 2))))
            .withBean("tsaCheck", DatumHealthCheck.class, () -> DatumHealthCheck.of("datum-tsa", () -> Status.down("no key")))
            .withBean("brokenCheck", DatumHealthCheck.class, () -> DatumHealthCheck.of("broken", () -> {
                throw new IllegalStateException("x");
            }))
            .run(context -> {
                HealthContributor datum = context.getBean("datumHealthIndicator", HealthContributor.class);
                assertThat(datum).isInstanceOf(CompositeHealthContributor.class).isInstanceOf(DatumHealthContributor.class);
                CompositeHealthContributor composite = (CompositeHealthContributor) datum;
                assertThat(composite.stream().map(entry -> entry.name())).containsExactly("broken", "datum-tsa", "runtime");
                HealthIndicator runtime = (HealthIndicator) composite.getContributor("runtime");
                assertThat(runtime.health().getStatus().getCode()).isEqualTo("UP");
                assertThat(runtime.health().getDetails()).containsEntry("slots", 2);
                HealthIndicator tsa = (HealthIndicator) composite.getContributor("datum-tsa");
                assertThat(tsa.health().getStatus().getCode()).isEqualTo("DOWN");
                assertThat(tsa.health().getDetails()).containsEntry("reason", "no key");
                assertThat(((HealthIndicator) composite.getContributor("broken")).health().getDetails())
                    .containsEntry("reason", "IllegalStateException");
                assertThat(composite.getContributor("absent")).isNull();
            });
    }

    /**
     * Through Boot's health endpoint: a group that includes {@code datum/up-one} alone is UP while the
     * whole health is DOWN (the other member is), the group shows only that member, and a group naming a member Datum does
     * not have stops the start (Boot's group-membership check reads the composite's members at start).
     */
    @Test
    void aHealthGroupIncludesOneDatumMember() {
        WebApplicationContextRunner runner = new WebApplicationContextRunner()
            .withConfiguration(ALL)
            .withConfiguration(AutoConfigurations.of(HealthContributorAutoConfiguration.class,
                HealthContributorRegistryAutoConfiguration.class, HealthEndpointAutoConfiguration.class))
            .withBean("upCheck", DatumHealthCheck.class, () -> DatumHealthCheck.of("up-one", () -> Status.up(Map.of())))
            .withBean("downCheck", DatumHealthCheck.class, () -> DatumHealthCheck.of("down-one", () -> Status.down("no key")))
            .withPropertyValues("management.endpoint.health.show-components=always");
        runner.withPropertyValues("management.endpoint.health.group.ready.include=datum/up-one").run(context -> {
            assertThat(context).hasNotFailed();
            HealthEndpoint health = context.getBean(HealthEndpoint.class);
            assertThat(health.health().getStatus().getCode()).isEqualTo("DOWN");
            HealthDescriptor ready = health.healthForPath("ready");
            assertThat(ready.getStatus().getCode()).isEqualTo("UP");
            HealthDescriptor datum = ((CompositeHealthDescriptor) ready).getComponents().get("datum");
            assertThat(((CompositeHealthDescriptor) datum).getComponents()).containsOnlyKeys("up-one");
            assertThat(health.healthForPath("datum", "down-one").getStatus().getCode()).isEqualTo("DOWN");
        });
        runner.withPropertyValues("management.endpoint.health.group.ready.include=datum/absent")
            .run(context -> assertThat(context).hasFailed().getFailure().hasStackTraceContaining("datum/absent"));
    }

    @Test
    void withNoCheckTheDatumHealthIsUp() {
        new ApplicationContextRunner().withConfiguration(ALL).run(context -> {
            HealthContributor datum = context.getBean("datumHealthIndicator", HealthContributor.class);
            assertThat(datum).isInstanceOf(HealthIndicator.class);
            assertThat(((HealthIndicator) datum).health().getStatus().getCode()).isEqualTo("UP");
        });
    }

    /** The standard switches reach Datum's health and info, the defaults switch included. */
    @Test
    void theStandardSwitchesTurnDatumsHealthAndInfoOff() {
        ApplicationContextRunner runner = new ApplicationContextRunner().withConfiguration(ALL);
        runner.withPropertyValues("management.health.datum.enabled=false")
            .run(context -> assertThat(context).doesNotHaveBean("datumHealthIndicator").hasSingleBean(DatumInfoContributor.class));
        runner.withPropertyValues("management.health.defaults.enabled=false")
            .run(context -> assertThat(context).doesNotHaveBean("datumHealthIndicator"));
        runner.withPropertyValues("management.health.defaults.enabled=false", "management.health.datum.enabled=true")
            .run(context -> assertThat(context).hasBean("datumHealthIndicator"));
        runner.withPropertyValues("management.info.datum.enabled=false")
            .run(context -> assertThat(context).doesNotHaveBean(DatumInfoContributor.class).hasBean("datumHealthIndicator"));
        runner.withPropertyValues("management.info.defaults.enabled=false")
            .run(context -> assertThat(context).doesNotHaveBean(DatumInfoContributor.class));
    }

    /**
     * One {@link DatumEventPublisher} bean, guarded, over the application's event publisher: a listener that
     * throws reaches no caller. An application's own bean replaces it (a recording publisher, an outbox).
     */
    @Test
    void theEventPublisherIsOneGuardedReplaceableBean() {
        List<Object> heard = new ArrayList<>();
        new ApplicationContextRunner().withConfiguration(ALL)
            .withBean(ApplicationListener.class, () -> (ApplicationListener<PayloadApplicationEvent<?>>) event -> {
                heard.add(event.getPayload());
                throw new AssertionError("a listener's invariant");
            })
            .run(context -> {
                DatumEventPublisher events = context.getBean(DatumEventPublisher.class);
                assertThat(events).isSameAs(DatumEventPublisher.guarded(events));
                events.publish("an event");
                assertThat(heard).containsExactly("an event");
            });
        AtomicReference<Object> recorded = new AtomicReference<>();
        DatumEventPublisher own = recorded::set;
        new ApplicationContextRunner().withConfiguration(ALL).withBean(DatumEventPublisher.class, () -> own)
            .run(context -> assertThat(context.getBean(DatumEventPublisher.class)).isSameAs(own));
    }

    /**
     * The guard is Datum's default, not a wrapper around an application's own
     * publisher. The bindings hand an application bean to their libraries as given, so a replacement that throws (an outbox
     * write that failed) reaches the code that published; without one the default is the guarded Spring publisher.
     */
    @Test
    void anApplicationsOwnPublisherIsHandedOverAsGivenAndItsFailureReachesTheCaller() {
        DatumEventPublisher outbox = event -> {
            throw new IllegalStateException("outbox down");
        };
        new ApplicationContextRunner().withConfiguration(ALL).withBean(DatumEventPublisher.class, () -> outbox).run(context -> {
            DatumEventPublisher handed = com.argusvane.datum.springweb.spring.SpringEventPublisher.of(
                context.getBeanProvider(DatumEventPublisher.class), context);
            assertThat(handed).isSameAs(outbox);
            org.assertj.core.api.Assertions.assertThatIllegalStateException().isThrownBy(() -> handed.publish("an event"))
                .withMessage("outbox down");
        });
        // A context without datum-spring-web's auto-configuration (a slice) gets the guarded Spring publisher.
        new ApplicationContextRunner().run(context -> {
            DatumEventPublisher fallback = com.argusvane.datum.springweb.spring.SpringEventPublisher.of(
                context.getBeanProvider(DatumEventPublisher.class), context);
            assertThat(fallback).isSameAs(DatumEventPublisher.guarded(fallback));
        });
    }

    /**
     * Datum's observations are on the application's ObservationRegistry when there is one, and
     * {@code none()} otherwise, which changes nothing; an application bean replaces them; without Micrometer's
     * Observation API on the class path there is no bean, and the bindings take {@code none()}.
     */
    @Test
    void theObservationsFollowTheApplicationsRegistry() {
        new ApplicationContextRunner().withConfiguration(ALL).run(context -> assertThat(context.getBean(
            com.argusvane.datum.core.observation.DatumObservations.class)).isSameAs(com.argusvane.datum.core.observation.DatumObservations.none()));
        new ApplicationContextRunner().withConfiguration(ALL)
            .withBean(io.micrometer.observation.ObservationRegistry.class, io.micrometer.observation.ObservationRegistry::create)
            .run(context -> {
                com.argusvane.datum.core.observation.DatumObservations observations =
                    context.getBean(com.argusvane.datum.core.observation.DatumObservations.class);
                assertThat(observations).isInstanceOfSatisfying(com.argusvane.datum.core.observation.MicrometerObservations.class,
                    micrometer -> assertThat(micrometer.registry()).isSameAs(context.getBean(io.micrometer.observation.ObservationRegistry.class)));
                assertThat(observations.enabled()).isTrue();
            });
        new ApplicationContextRunner().withConfiguration(ALL).withClassLoader(new FilteredClassLoader("io.micrometer.observation"))
            .run(context -> assertThat(context).hasNotFailed().doesNotHaveBean(com.argusvane.datum.core.observation.DatumObservations.class));
    }

    /** The capabilities are the {@link DatumCapability} beans, merged; nothing registers into the bean. */
    @Test
    void infoDatumNamesTheBuildAbisAndCapabilities() {
        new ApplicationContextRunner().withConfiguration(ALL)
            .withBean("submissionsCapability", DatumCapability.class, () -> DatumCapability.of("submissions")
                .withDetail("engine", () -> "endive").withDetail("nativeProvider", () -> null))
            .withBean("formsCapability", DatumCapability.class, () -> DatumCapability.of("forms"))
            .run(context -> {
            Info.Builder builder = new Info.Builder();
            context.getBean(DatumInfoContributor.class).contribute(builder);
            @SuppressWarnings("unchecked")
            Map<String, Object> datum = (Map<String, Object>) builder.build().get("datum");
            assertThat(datum).containsEntry("engineVersion", "1.2.3").containsEntry("sandboxAbi", "1.0.0")
                .containsEntry("pdfAbi", "1.0.0").containsEntry("buildId", "testbuild1").containsEntry("engine", "endive")
                .doesNotContainKey("nativeProvider");
            assertThat(datum.get("capabilities").toString()).isEqualTo("[forms, submissions]");
        });
    }

    @Test
    void metersAreRecordedWhenARegistryExistsAndIgnoredWhenNot() {
        new ApplicationContextRunner().withConfiguration(ALL).run(context -> {
            DatumMeters meters = context.getBean(DatumMeters.class);
            meters.increment("datum.throttled", "kind", "submit");
            meters.record("datum.runs", Duration.ofMillis(5), "program", "sandbox");
        });
        new ApplicationContextRunner().withConfiguration(ALL).withBean(MeterRegistry.class, SimpleMeterRegistry::new).run(context -> {
            DatumMeters meters = context.getBean(DatumMeters.class);
            MeterRegistry registry = context.getBean(MeterRegistry.class);
            meters.increment("datum.throttled", "kind", "submit");
            meters.record("datum.runs", Duration.ofMillis(5), "program", "sandbox", "outcome", "ok");
            meters.gauge("datum.runs.active", () -> 3, "program", "sandbox");
            meters.summary("datum.pdf.bytes", 1234);
            assertThat(registry.get("datum.throttled").tag("kind", "submit").counter().count()).isEqualTo(1.0);
            assertThat(registry.get("datum.runs").timer().count()).isEqualTo(1);
            assertThat(registry.get("datum.runs.active").gauge().value()).isEqualTo(3.0);
            assertThat(registry.get("datum.pdf.bytes").summary().totalAmount()).isEqualTo(1234.0);
        });
    }
}
