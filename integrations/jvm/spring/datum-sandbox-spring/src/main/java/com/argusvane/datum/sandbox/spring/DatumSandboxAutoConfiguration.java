package com.argusvane.datum.sandbox.spring;

import com.argusvane.datum.core.DatumEventPublisher;
import com.argusvane.datum.core.DatumStartupCheck;
import com.argusvane.datum.core.observation.DatumObservations;
import com.argusvane.datum.sandbox.diagnostics.RunCaptureSink;
import com.argusvane.datum.sandbox.diagnostics.RunTrace;
import com.argusvane.datum.sandbox.observation.SandboxRunMetrics;
import com.argusvane.datum.sandbox.protocol.AbiProbe;
import com.argusvane.datum.sandbox.protocol.HostOptions;
import com.argusvane.datum.sandbox.protocol.PdfKernelDecorator;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.protocol.RunLog;
import com.argusvane.datum.sandbox.protocol.Sandbox;
import com.argusvane.datum.sandbox.protocol.SandboxDecorator;
import com.argusvane.datum.sandbox.runtime.DatumSandbox;
import com.argusvane.datum.sandbox.runtime.Engines;
import com.argusvane.datum.sandbox.runtime.MemoryBudget;
import com.argusvane.datum.sandbox.runtime.ProgramStore;
import com.argusvane.datum.sandbox.runtime.SandboxSettings;
import com.argusvane.datum.sandbox.runtime.SandboxStatus;
import com.argusvane.datum.sandbox.wasi.EngineSettings;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.wasi.GuestRuntimeProvider;
import com.argusvane.datum.sandbox.wasi.GuestRuntimes;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import com.argusvane.datum.springweb.spring.SpringEventPublisher;
import com.argusvane.datum.web.WebSettings;
import com.argusvane.datum.web.monitoring.DatumHealthCheck;
import com.argusvane.datum.web.monitoring.DatumHealthContributors;
import java.time.Clock;
import java.util.List;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.ConfigurableListableBeanFactory;
import org.springframework.beans.factory.config.BeanDefinition;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.actuate.autoconfigure.endpoint.condition.ConditionalOnAvailableEndpoint;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Scope;
import org.springframework.core.io.ResourceLoader;

/**
 * The sandbox for Spring Boot: everything between {@code datum.runtime.*} and the framework-free
 * {@link DatumSandbox}. The properties are mapped onto one {@link SandboxSettings} (which clamps, and explains what it did); the
 * engine {@code datum.runtime.engine} names is selected and created; the sandbox is started and stopped by
 * {@link DatumSandboxLifecycle}; health, the {@code datum} actuator endpoint and the run meters read it. The submissions and PDF
 * bindings take their runtime from here and order after it, so neither needs the other for it.
 *
 * <p>Every bean backs off for an application bean of the same type; {@code datum.enabled=false} switches the module off. Events go
 * through the {@code datumEventPublisher} bean ({@link SpringEventPublisher#of}).
 */
@AutoConfiguration(after = DatumWebAutoConfiguration.class)
@ConditionalOnProperty(prefix = "datum", name = "enabled", matchIfMissing = true)
@EnableConfigurationProperties({DatumSandboxProperties.class, DatumHostProperties.class})
public final class DatumSandboxAutoConfiguration {

    // =========================================================================================== limits and host options

    /** {@code datum.runtime.*} and {@code datum.host.*} as the library reads them: one value, clamped and explainable. */
    @Bean
    @ConditionalOnMissingBean
    SandboxSettings datumSandboxSettings(DatumSandboxProperties runtime, DatumHostProperties host) {
        return runtime.toSettings(host);
    }

    /**
     * The budgets, slots and sizes of both programs, from the settings' effective values; the body cap is
     * {@code datum.web.api.max-body-size}.
     */
    @Bean
    @ConditionalOnMissingBean
    ProgramLimits datumProgramLimits(SandboxSettings settings, ObjectProvider<WebSettings> web) {
        return settings.limits(web.getIfAvailable(WebSettings::defaults).api().maxBodyBytes());
    }

    /** {@code datum.host.*}: the formula policy, the pattern policy and the time zone of {@code today}, on the application's clock. */
    @Bean
    @ConditionalOnMissingBean
    HostOptions datumHostOptions(SandboxSettings settings, ObjectProvider<Clock> clock) {
        return settings.host().hostOptions(clock.getIfAvailable(Clock::systemUTC));
    }

    // =========================================================================================== the runtime

    /** The name of the binding's own engine bean, which the settings report tells apart from an application's. */
    static final String GUEST_RUNTIME = "datumGuestRuntime";

    /**
     * The engine {@code datum.runtime.engine} names ({@code endive} by default), found through the
     * {@link GuestRuntimeProvider} services on the application's class loader (no class is named in configuration or
     * loaded by reflection on a name) and created for the program limits through {@link Engines#create}: the engine is
     * handed the memory budgets, and one it cannot honour stops the start as a {@code DatumConfigurationException} naming
     * its property. An id no provider has, or whose provider is unavailable here, stops the start naming the provider's reason
     * and every engine found, whatever {@code datum.runtime.fail-fast} says: it is a configuration error, not a program to prove
     * later. An application's own {@code GuestRuntime} bean wins, and then the property is not read. The runtime's
     * {@code close()} is the bean's destroy method.
     */
    @Bean(GUEST_RUNTIME)
    @ConditionalOnMissingBean(GuestRuntime.class)
    GuestRuntime datumGuestRuntime(SandboxSettings settings, ProgramLimits limits, EngineSettings engineSettings, ResourceLoader resourceLoader) {
        ClassLoader loader = resourceLoader.getClassLoader() != null ? resourceLoader.getClassLoader()
            : DatumSandboxAutoConfiguration.class.getClassLoader();
        // The EngineSelectionException is not wrapped: it carries the id asked for and every engine found, and this module's
        // FailureAnalyzer turns it into the one Description and Action that stops the start.
        GuestRuntimeProvider provider = GuestRuntimes.select(settings.engine().id(), loader);
        return Engines.create(provider, limits, engineSettings);
    }

    /**
     * What the engine is created with besides the limits: the stop grace and the stray bound, from the settings' engine
     * ({@code datum.runtime.stop-grace}, {@code datum.runtime.max-strays}). A bean of the application's own replaces it, for an
     * operator on a large host or one with slow native set-up who tunes the engine without building it by hand.
     */
    @Bean
    @ConditionalOnMissingBean
    EngineSettings datumEngineSettings(SandboxSettings settings) {
        return settings.engine().engineSettings();
    }

    /** The programs: datum-programs' (sha-checked) or the {@code datum.runtime.programs.*} overrides. */
    @Bean
    @ConditionalOnMissingBean
    ProgramStore datumProgramStore(SandboxSettings settings) {
        return settings.programStore(DatumSandboxAutoConfiguration.class.getClassLoader());
    }

    /**
     * Where a real submission's run log goes: the guest's {@code context.log} entries, after the run. The default
     * writes each entry as one line to the SLF4J logger {@value RunLog#LOGGER}, every control character escaped
     * ({@link RunLog#oneLine}). An application's own bean (a structured sink, an audit trail) replaces it and then receives
     * the guest's text as the guest wrote it: escape it before it reaches a line-oriented log.
     */
    @Bean
    @ConditionalOnMissingBean
    RunLog datumRunLog() {
        return RunLog.slf4j();
    }

    /**
     * The ABI gate of one proof, on the application's clock (the PDF failure memory's). A prototype: the runtime
     * asks for one at start and at every recheck, so a recheck proves the programs again. An application's own bean should
     * stay a prototype; a singleton is used, with a WARN, and a recheck then trusts what it remembers.
     */
    @Bean
    @Scope(BeanDefinition.SCOPE_PROTOTYPE)
    @ConditionalOnMissingBean
    AbiProbe datumAbiProbe(ObjectProvider<Clock> clock) {
        return new AbiProbe(clock.getIfAvailable(Clock::systemUTC));
    }

    /**
     * The sandbox's lifecycle, slots and gate. The run log and the ABI gate are the beans above, so beans of the application
     * replace them. The runtime builds the sandbox and the PDF program itself at every start and recheck and hands them to the
     * application's {@link SandboxDecorator} and {@link PdfKernelDecorator} beans in the framework's order ({@code @Order},
     * {@code Ordered}, {@code @Priority}): the first wraps Datum's, the last sees each call first, and every decorator sees
     * every run (the ABI proof, the warm-ups, the receiver's, the definition service's, the inspection's and every PDF render,
     * fill, sign and verify). Datum's own observation of each guest run ({@code datum.sandbox.run}, {@code datum.pdf.run}) sits
     * directly around the protocol when the application has an {@code ObservationRegistry} (the {@link DatumObservations} bean
     * of datum-spring-web), else nothing is wrapped. Its health check is the bean below, over whichever runtime the context has.
     *
     * <p>Diagnostics ({@code datum.runtime.diagnostics.*}): an application's {@link RunTrace} bean replaces the log line, and its
     * {@link RunCaptureSink} bean the capture directory; the trace mode, the capture's bounds and its queue are the settings'
     * either way. The binding's own engine is handed over with the {@link EngineSettings} it was made with, so the settings
     * report shows an application's {@code EngineSettings}, {@code ProgramLimits} or {@code HostOptions} bean, or its own
     * {@code GuestRuntime}, as {@code REPLACED}.
     */
    @Bean
    @ConditionalOnMissingBean
    DatumSandbox datumSandboxRuntime(ObjectProvider<GuestRuntime> guestRuntime, ProgramStore store, ProgramLimits limits,
                                     HostOptions hostOptions, SandboxSettings settings, ObjectProvider<DatumEventPublisher> publisher,
                                     ApplicationEventPublisher events, RunLog runLog, ObjectProvider<AbiProbe> probes,
                                     ObjectProvider<SandboxDecorator> sandboxDecorators,
                                     ObjectProvider<PdfKernelDecorator> pdfKernelDecorators,
                                     ObjectProvider<DatumObservations> observations, ObjectProvider<RunTrace> runTrace,
                                     ObjectProvider<RunCaptureSink> captureSink, ObjectProvider<EngineSettings> engineSettings,
                                     ConfigurableListableBeanFactory beans) {
        DatumSandbox.Builder builder = DatumSandbox.builder()
            .store(store)
            .limits(limits)
            .hostOptions(hostOptions)
            .settings(settings)
            .events(SpringEventPublisher.of(publisher, events))
            .runLog(runLog)
            .probes(probes::getObject)
            .sandboxDecorators(sandboxDecorators.orderedStream().toList())
            .pdfKernelDecorators(pdfKernelDecorators.orderedStream().toList())
            .observations(observations.getIfAvailable(DatumObservations::none));
        RunTrace trace = runTrace.getIfUnique();
        if (trace != null) {
            builder.runTrace(trace);
        }
        RunCaptureSink sink = captureSink.getIfUnique();
        if (sink != null) {
            builder.captureSink(sink);
        }
        // The engine bean, the application's own included; none leaves the sandbox DOWN with its reason (the bean is always
        // there unless the application removed it). The binding's own was made with the EngineSettings bean; an application's
        // own runtime was made however the application made it.
        GuestRuntime engine = guestRuntime.getIfAvailable();
        if (engine == null) {
            return builder.withoutRuntime().build();
        }
        EngineSettings madeWith = engineSettings.getIfUnique();
        boolean ours = List.of(beans.getBeanNamesForType(GuestRuntime.class, true, false)).equals(List.of(GUEST_RUNTIME))
            && madeByThisConfiguration(beans, GUEST_RUNTIME);
        return (ours && madeWith != null ? builder.runtime(engine, madeWith) : builder.runtime(engine)).build();
    }

    /**
     * Whether a bean is the binding's own: its definition is this configuration's factory method, not merely a bean of the
     * same name (an application may name its own engine {@value #GUEST_RUNTIME}; it is then the application's, REPLACED).
     */
    static boolean madeByThisConfiguration(ConfigurableListableBeanFactory beans, String name) {
        if (!beans.containsBeanDefinition(name)) {
            return false;
        }
        BeanDefinition definition = beans.getBeanDefinition(name);
        if (definition instanceof org.springframework.beans.factory.annotation.AnnotatedBeanDefinition annotated
            && annotated.getFactoryMethodMetadata() != null) {
            return DatumSandboxAutoConfiguration.class.getName().equals(annotated.getFactoryMethodMetadata().getDeclaringClassName());
        }
        if (definition instanceof org.springframework.beans.factory.support.RootBeanDefinition root && root.getResolvedFactoryMethod() != null) {
            // An ahead-of-time context's definitions carry the method itself.
            return root.getResolvedFactoryMethod().getDeclaringClass() == DatumSandboxAutoConfiguration.class;
        }
        return false;
    }

    /** The {@code runtime} health check ({@code datum/runtime}), over the sandbox bean, the application's own included. */
    @Bean
    DatumHealthCheck datumRuntimeHealthCheck(DatumSandbox sandbox) {
        return DatumHealthCheck.of("runtime", () -> {
            SandboxStatus status = sandbox.status();
            return new DatumHealthContributors.Status(status.isUp(), status.details());
        });
    }

    /**
     * Starts the sandbox before the web server takes requests and stops it after the server stopped taking them
     * ({@link DatumSandboxLifecycle#PHASE}); the sandbox itself is a plain class.
     */
    @Bean
    @ConditionalOnMissingBean
    DatumSandboxLifecycle datumSandboxLifecycle(DatumSandbox sandbox) {
        return new DatumSandboxLifecycle(sandbox);
    }

    /** The name of the sandbox's {@link Sandbox} bean, the default the binding offers. */
    static final String SANDBOX = "datumSandbox";

    /**
     * The sandbox while the runtime is UP, else no bean (null): a prototype, so every caller that asks its
     * {@code ObjectProvider} on each call (datum-forms' {@code DefinitionService}, the submission service, {@code SubmissionsApi})
     * gets the sandbox of the programs proved last (a recheck may reload them) and a typed 503 while the runtime is down.
     * The three share this one bean, so a {@link SandboxDecorator} bean, or a {@code BeanPostProcessor} that wraps
     * this bean (request runs only, and on every call: the decorator is the preferred route), sees every run they make.
     * Inject {@code ObjectProvider<Sandbox>} or {@link DatumSandbox}, never the sandbox itself.
     *
     * <p>Replaceable, as a Spring developer expects of a bean: an application's own {@code Sandbox} bean is what the request
     * runs use, and the decorator chain is applied to whatever bean exists, this default or a replacement, in a step the binding
     * owns ({@link #datumReplacementSandboxDecorator}: Boot's idiom of customizers applying to the bean that is there). So a
     * replacement can never skip the host's {@link SandboxDecorator}s or Datum's {@code datum.sandbox.run} observation. A
     * decorator that returns a sandbox of its own instead of wrapping the one it is handed is still against the documented
     * contract, which the code cannot enforce.
     */
    @Bean(SANDBOX)
    @Scope(BeanDefinition.SCOPE_PROTOTYPE)
    @ConditionalOnMissingBean(Sandbox.class)
    Sandbox datumSandbox(DatumSandbox sandbox) {
        return sandbox.sandboxOrNull();
    }

    /**
     * The wrapping step for a replacement {@link Sandbox} bean: the runtime's chain (Datum's observation, then the
     * {@link SandboxDecorator} beans in order) around any {@code Sandbox} bean that is not this binding's default, which the
     * runtime has wrapped already. A static bean method with lazy providers, so the post-processor does not pull the runtime
     * or the decorators in early.
     */
    @Bean
    static BeanPostProcessor datumReplacementSandboxDecorator(ObjectProvider<DatumSandbox> sandbox) {
        return new ReplacementSandboxDecorator(sandbox);
    }

    // =========================================================================================== start-up checks

    /**
     * The library's start-up check of the sandbox's memory (integrations/jvm/README.md "Libraries and bindings"), run once every
     * bean exists by datum-spring-web's runner: the WARN when the slots do not fit the container's memory beside the heap.
     */
    @Bean
    DatumStartupCheck datumMemoryBudgetStartupCheck(ObjectProvider<DatumSandbox> sandbox, ObjectProvider<ProgramLimits> limits) {
        return () -> {
            DatumSandbox one = sandbox.getIfUnique();
            ProgramLimits set = limits.getIfUnique();
            return one == null || set == null ? List.of() : MemoryBudget.startupCheck(one, set).check();
        };
    }

    // =========================================================================================== actuator, metrics

    /** The {@code datum} endpoint ({@code status}, {@code recheck}), when actuator is present and the endpoint is exposed. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(name = "org.springframework.boot.actuate.endpoint.annotation.Endpoint")
    static class ActuatorConfiguration {

        @Bean
        @ConditionalOnMissingBean
        @ConditionalOnAvailableEndpoint(endpoint = DatumEndpoint.class)
        DatumEndpoint datumEndpoint(DatumSandbox sandbox) {
            return new DatumEndpoint(sandbox);
        }
    }

    /**
     * The run meters, when Micrometer is present: the sandbox's binder, which also counts {@code datum.runs.rejected} (told by
     * the slots themselves, so every channel's busy refusal is counted, not only the HTTP mapper's). {@code DatumMeters}
     * (datum-spring-web) reads the registry lazily and does nothing without one.
     */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(name = "io.micrometer.core.instrument.binder.MeterBinder")
    static class MetricsConfiguration {

        @Bean
        @ConditionalOnMissingBean
        SandboxRunMetrics datumRunMetrics(DatumSandbox sandbox) {
            return new SandboxRunMetrics(sandbox);
        }
    }
}
