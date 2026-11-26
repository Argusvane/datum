package com.argusvane.datum.pdf.spring;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.forms.spring.DatumFormsAutoConfiguration;
import com.argusvane.datum.pdf.KeyStorePdfSigner;
import com.argusvane.datum.pdf.PdfRequestCustomizer;
import com.argusvane.datum.pdf.PdfResultValidator;
import com.argusvane.datum.pdf.PdfRuntime;
import com.argusvane.datum.pdf.PdfFonts;
import com.argusvane.datum.pdf.PdfService;
import com.argusvane.datum.pdf.PdfSigner;
import com.argusvane.datum.pdf.SealPreset;
import com.argusvane.datum.pdf.config.PdfSettings;
import com.argusvane.datum.pdf.verify.PdfTrust;
import com.argusvane.datum.timestamp.web.TsaCertificates;
import com.argusvane.datum.timestamp.web.TsaSettings;
import com.argusvane.datum.pdf.verify.PdfTrustPolicy;
import com.argusvane.datum.pdf.verify.PdfVerifier;
import com.argusvane.datum.core.DatumEventPublisher;
import com.argusvane.datum.core.contracts.DatumJson;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import com.argusvane.datum.springweb.spring.SigningBundles;
import com.argusvane.datum.springweb.spring.SpringEventPublisher;
import com.argusvane.datum.springweb.spring.SpringResources;
import com.argusvane.datum.sandbox.runtime.DatumSandbox;
import com.argusvane.datum.sandbox.spring.DatumSandboxAutoConfiguration;
import com.argusvane.datum.submissions.spring.DatumSubmissionsAutoConfiguration;
import com.argusvane.datum.timestamp.TimestampAuthority;
import com.argusvane.datum.timestamp.TimestampClient;
import com.argusvane.datum.timestamp.Timestamper;
import com.argusvane.datum.timestamp.TsaKey;
import com.argusvane.datum.timestamp.TsaKeyException;
import com.argusvane.datum.timestamp.TsaKeyMaterial;
import com.argusvane.datum.web.monitoring.DatumCapability;
import com.argusvane.datum.web.monitoring.DatumHealthCheck;
import com.argusvane.datum.web.monitoring.DatumHealthContributors;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.cert.X509Certificate;
import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import com.argusvane.datum.timestamp.JdkTsaTransport;
import com.argusvane.datum.timestamp.TsaTransport;
import java.net.http.HttpClient;
import java.time.Duration;
import org.springframework.boot.http.client.ClientHttpRequestFactoryBuilder;
import org.springframework.boot.http.client.HttpClientSettings;
import org.springframework.boot.http.client.HttpRedirects;
import org.springframework.boot.ssl.NoSuchSslBundleException;
import org.springframework.boot.ssl.SslBundle;
import org.springframework.web.client.RestClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.boot.ssl.SslBundles;
import org.springframework.boot.task.SimpleAsyncTaskExecutorBuilder;
import org.springframework.core.task.TaskDecorator;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.core.env.Environment;
import org.springframework.core.io.Resource;
import org.springframework.core.io.ResourceLoader;

/**
 * The PDF capability: {@link PdfService} over datum-sandbox-spring's runtime (its PDF slots and program), the server's
 * signer from {@code datum.pdf.signing.ssl-bundle} (a Spring Boot SSL bundle), the timestamp source (the
 * application's own {@link Timestamper} bean, else a named server when {@code datum.pdf.signing.tsa.url} is set, else the
 * application's own {@link TimestampAuthority} when the timestamp module is on), the trust verification places signers
 * against and the {@link PdfTrustPolicy} and {@link PdfVerifier} that judge them, the {@code pdf} health check and capability,
 * and the endpoints ({@code web.PdfWebConfiguration}; the OpenAPI group is the separate
 * {@code web.DatumPdfOpenApiAutoConfiguration}, which springdoc's ordering needs). Every bean backs off for an
 * application bean of the same type; {@code datum.pdf.enabled=false} (or {@code datum.enabled=false}) switches the
 * module off. A setting that cannot be used (an unknown font pack or certify word, an unreadable signing bundle) stops the
 * start naming the property, never a password.
 */
@AutoConfiguration(after = {DatumWebAutoConfiguration.class, DatumFormsAutoConfiguration.class, DatumSandboxAutoConfiguration.class,
    DatumSubmissionsAutoConfiguration.class},
    afterName = {"com.argusvane.datum.timestamp.spring.DatumTimestampAutoConfiguration",
        // The TSA transport's REST client branch is a condition on RestClient.Builder and reads the request-factory
        // beans, so Boot's two auto-configurations that make them run first.
        "org.springframework.boot.http.client.autoconfigure.HttpClientAutoConfiguration",
        "org.springframework.boot.restclient.autoconfigure.RestClientAutoConfiguration"})
@ConditionalOnClass(PdfService.class)
@ConditionalOnProperty(prefix = "datum", name = "enabled", matchIfMissing = true)
@ConditionalOnProperty(prefix = "datum.pdf", name = "enabled", matchIfMissing = true)
@EnableConfigurationProperties({DatumPdfProperties.class, DatumPdfVerifyProperties.class})
public final class DatumPdfAutoConfiguration {

    private static final Logger LOG = LoggerFactory.getLogger(DatumPdfAutoConfiguration.class);

    /** {@code datum.pdf.*} as the library reads it. */
    @Bean
    @ConditionalOnMissingBean
    PdfSettings datumPdfSettings(DatumPdfProperties properties, DatumPdfVerifyProperties verify) {
        return properties.toSettings().withVerifyMaxBytes(verify.toBytes());
    }

    /**
     * What {@link PdfService} asks of the runtime, adapted from the sandbox's (asked afresh on every call). Replaceable by an
     * application's own {@link PdfRuntime} bean; the host's {@code PdfKernelDecorator} beans and Datum's {@code datum.pdf.run}
     * observation are applied to whichever bean exists, this default (the runtime wrapped its kernels itself) or a replacement
     * ({@link #datumReplacementPdfRuntimeDecorator}), so a replacement can never skip them.
     */
    @Bean
    @ConditionalOnMissingBean
    PdfRuntime datumPdfRuntime(DatumSandbox runtime) {
        return PdfRuntime.of(runtime);
    }

    /**
     * The wrapping step for a replacement {@link PdfRuntime} bean: its program goes through the runtime's PDF chain (Datum's
     * observation, then the {@code PdfKernelDecorator} beans in order), once per kernel. The default bean is left alone. A static
     * bean method with a lazy provider, so the post-processor does not pull the runtime in early.
     */
    @Bean
    static BeanPostProcessor datumReplacementPdfRuntimeDecorator(ObjectProvider<DatumSandbox> runtime) {
        return new ReplacementPdfRuntimeDecorator(runtime);
    }

    /**
     * The server's signer, when {@code datum.pdf.signing.ssl-bundle} names a Spring Boot SSL bundle. The start fails if the key
     * cannot be read.
     */
    @Bean
    @ConditionalOnMissingBean(PdfSigner.class)
    @ConditionalOnProperty(prefix = "datum.pdf.signing", name = "ssl-bundle")
    PdfSigner datumPdfSigner(DatumPdfProperties properties, ObjectProvider<SslBundles> bundles) {
        String bundle = properties.getSigning().getSslBundle();
        if (bundle == null) {
            // An empty ssl-bundle is unset: no server signer.
            return null;
        }
        SigningBundles.Lookup found = SigningBundles.key(bundles, bundle, "datum.pdf.signing.ssl-bundle");
        if (found.problem() != null) {
            throw new IllegalArgumentException(found.problem());
        }
        SigningBundles.Key key = found.key();
        try {
            return KeyStorePdfSigner.fromKeyStore(key.store(), key.alias(), key.password());
        } catch (IllegalArgumentException e) {
            throw new DatumConfigurationException("datum.pdf.signing.ssl-bundle", "datum.pdf.signing.ssl-bundle (the bundle \"" + bundle + "\"): " + e.getMessage(), e);
        }
    }

    /**
     * What verification places signers against: the current signer (added by the service), the certificates the
     * server signed with before a rotation, the trust anchors, and the timestamp authority's own certificates
     * (the current one and {@code datum.tsa.retired-certificates}).
     *
     * <p>The retired timestamp certificates are the ones the timestamp server publishes: with
     * the server on, its {@link TsaCertificates} bean's retired chains, so the list {@code /tsa/certificates} serves is the
     * list this verifier places, also when an application replaced that bean (its chains from a key vault, the property
     * empty); without that bean but with a {@link TsaSettings} bean, the settings' entries; on a PDF-only host, the
     * property. Each entry read here is a location as {@link SpringResources#location} takes it, a bare path being a file,
     * as the timestamp server reads the same entries; handing a bare path to the resource loader made it a class-path or
     * servlet-context resource, and a host with both modules on did not start.
     */
    @Bean
    @ConditionalOnMissingBean
    PdfTrust datumPdfTrust(PdfSettings settings, ObjectProvider<Clock> clock, ObjectProvider<TsaKeyMaterial> tsaKeys,
                           ObjectProvider<TsaCertificates> tsaCertificates, ObjectProvider<TsaSettings> tsaSettings,
                           Environment environment, ResourceLoader resources) {
        PdfSettings.Signing signing = settings.signing();
        List<X509Certificate> retired = PdfSettings.certificates("datum.pdf.signing.retired-certificates", signing.retiredCertificates());
        List<X509Certificate> anchors = PdfSettings.certificates("datum.pdf.signing.trust-anchors", signing.trustAnchors());
        List<X509Certificate> retiredTsa = new ArrayList<>();
        TsaCertificates published = tsaCertificates.getIfAvailable();
        if (published != null) {
            published.retired().forEach(retiredTsa::addAll);
        } else {
            // A PEM resource per entry, as the timestamp server's /tsa/certificates serves them.
            TsaSettings tsa = tsaSettings.getIfAvailable();
            List<String> locations = tsa != null ? tsa.retiredCertificates()
                : Binder.get(environment).bind("datum.tsa.retired-certificates", Bindable.listOf(String.class)).orElse(List.of());
            for (String location : locations) {
                retiredTsa.addAll(PdfSettings.certificates("datum.tsa.retired-certificates", SpringResources.handle(SpringResources.location(resources, location))));
            }
        }
        TsaKeyMaterial keys = tsaKeys.getIfAvailable();
        return new PdfTrust(List::of, retired, anchors, () -> {
            List<X509Certificate> site = new ArrayList<>(retiredTsa);
            if (keys != null) {
                try {
                    TsaKey key = keys.load();
                    site.add(0, key.leaf());
                } catch (TsaKeyException e) {
                    // The authority has no usable key now: its older certificates still place the tokens it made.
                    LOG.debug("Datum PDF: the timestamp authority has no usable key ({}).", e.getMessage());
                }
            }
            return site;
        }, clock.getIfAvailable(Clock::systemUTC));
    }

    /**
     * What makes a signer or a timestamp authority {@code trusted}: the standard policy by default (the
     * configured {@code datum.pdf.signing.trust-anchors}, no revocation checking, every chain judged now). An application bean replaces it: its own anchors, revocation checking through the JDK's
     * PKIX revocation checker, chains judged at the signing time a trusted timestamp proves. The verify report names it.
     */
    @Bean
    @ConditionalOnMissingBean
    PdfTrustPolicy datumPdfTrustPolicy() {
        return PdfTrustPolicy.standard();
    }

    /**
     * The verifier that completes {@code POST /pdf/verify}: the trust above with the server's own signing
     * certificate as a site signer, judged under the trust policy. An application's {@link PdfVerifier} (a subclass that
     * logs or adds to the report) replaces it; it is then used as given, and should build its trust with
     * {@link PdfTrust#withSiteSigner} or this server's own seals verify as unknown (the service WARNs).
     */
    @Bean
    @ConditionalOnMissingBean
    PdfVerifier datumPdfVerifier(PdfTrust trust, PdfTrustPolicy policy, ObjectProvider<PdfSigner> signer) {
        PdfSigner server = signer.getIfAvailable();
        return new PdfVerifier(server == null ? trust : trust.withSiteSigner(server.leaf()), policy, DatumJson.mapper());
    }

    /**
     * The named timestamp server's client, {@code datum.pdf.signing.tsa.*}, built only when the application has no
     * {@link Timestamper} of its own: a qualified or custom authority is a {@code Timestamper} bean, and then this
     * client is not made and the URL is not read. The timestamp module's in-process {@link TimestampAuthority} is a
     * {@code Timestamper} too, but it is the fallback below a named server, not an application's choice, so it does not
     * count here. Every request carries {@code datum.pdf.signing.tsa.policy} as its {@code reqPolicy} when that is set.
     *
     * <p>The URL is read from the {@link PdfSettings} bean, not from the property, so an application's own settings bean
     * that names a server gets its client (overriding a settings bean is real), and one that names none wins
     * over the property and gets none. A condition cannot read a bean, so the test is in the method: no server is a null
     * bean, which {@code ObjectProvider} skips.
     */
    @Bean
    @ConditionalOnMissingBean(value = Timestamper.class, ignored = TimestampAuthority.class)
    TimestampClient datumPdfTimestampClient(PdfSettings settings, ObjectProvider<TsaTransport> transport) {
        PdfSettings.Tsa tsa = settings.signing().tsa();
        if (tsa.url() == null || tsa.url().isBlank()) {
            return null;
        }
        return timestampClient(tsa, transport.getIfAvailable());
    }

    /**
     * The font faces a request carries: DejaVu from datum-programs through this binding's class loader. An
     * application bean replaces them (its own faces, a pack read from elsewhere); {@code datum.pdf.fonts} still names which
     * pack of the faces a request carries.
     */
    @Bean
    @ConditionalOnMissingBean
    PdfFonts datumPdfFonts() {
        return PdfFonts.fromClasspath(DatumPdfAutoConfiguration.class.getClassLoader());
    }

    /**
     * The verify route's cap: {@code datum.runtime.verify-max-bytes} wins when the application set it, whatever
     * {@link PdfSettings} bean is in use (an application's own bean keeps the cap the property gives); otherwise the settings bean's own. The default settings bean has folded the property in already
     * (and logged its clamp), so a cap that matches it needs no second WARN.
     */
    private static long verifyMaxBytes(PdfSettings settings, DatumPdfVerifyProperties verify) {
        if (!verify.wasSet() || verify.getVerifyMaxBytes() == null) {
            return settings.verifyMaxBytes();
        }
        long bounded = PdfSettings.clampVerifyMaxBytes(verify.getVerifyMaxBytes().toBytes(), message -> { });
        return bounded == settings.verifyMaxBytes() ? bounded : verify.toBytes();
    }

    @Bean
    @ConditionalOnMissingBean
    PdfService datumPdfService(PdfRuntime runtime, PdfSettings settings, DatumPdfVerifyProperties verify, ObjectProvider<PdfSigner> signer, PdfVerifier verifier, PdfFonts fonts,
                               ObjectProvider<Timestamper> timestampers, ObjectProvider<TimestampAuthority> authority,
                               ObjectProvider<PdfRequestCustomizer> customizers, ObjectProvider<PdfResultValidator> validators,
                               ObjectProvider<Clock> clock, ObjectProvider<DatumEventPublisher> publisher, ApplicationEventPublisher events,
                               ObjectProvider<com.argusvane.datum.core.observation.DatumObservations> observations,
                               ObjectProvider<com.argusvane.datum.core.assets.HostBindings> bindings) {
        PdfSigner server = signer.getIfAvailable();
        SealPreset preset = settings.sealPreset();
        PdfService.Builder builder = PdfService.builder()
            .runtime(runtime)
            .fonts(fonts)
            .defaultFonts(settings.fontPack())
            // The framework's order (@Order, Ordered, @Priority); equal orders keep registration order.
            .customizers(customizers.orderedStream().toList())
            // The application's PdfResultValidator beans, in the same order rule.
            .validators(validators.orderedStream().toList())
            // datum.bindings.*: a form's binding suggests the PDF theme its PDF carries as the request's host theme; none, none.
            .bindings(bindings.getIfAvailable())
            .signer(server)
            .seal(preset)
            .verifier(verifier)
            .verifyMaxBytes(verifyMaxBytes(settings, verify))
            .events(SpringEventPublisher.of(publisher, events))
            // datum.pdf per operation, under the HTTP request's observation; none without a registry.
            .observations(observations.getIfAvailable(com.argusvane.datum.core.observation.DatumObservations::none))
            .clock(clock.getIfAvailable(Clock::systemUTC));
        // The application's own Timestamper first (a qualified or custom authority), else the named server's client (a bean
        // made only when there is none of the application's), else the in-process authority.
        Timestamper chosen = timestamper(timestampers);
        if (chosen != null) {
            builder.timestamper(chosen, chosen instanceof TimestampClient client ? client.url().toString() : "custom");
            if (!(chosen instanceof TimestampClient)) {
                unusedTimestampSettings(settings.signing().tsa());
            }
        } else if (authority.getIfAvailable() != null) {
            builder.timestamper(authority.getObject(), "site");
        }
        PdfService service = builder.build();
        if (preset.timestamp() && service.timestampSource().isEmpty()) {
            LOG.warn("Datum PDF: datum.pdf.seal.timestamp is on but no timestamp source is configured (datum.pdf.signing.tsa.url or a "
                + "TimestampAuthority bean): seals are made without a timestamp.");
        }
        if (!preset.enabled()) {
            LOG.info("Datum PDF: issued PDFs are not sealed (datum.pdf.seal.enabled is off).");
        }
        return service;
    }

    /** The {@code pdf} health check ({@code datum/pdf}), over the service bean, the application's own included. */
    @Bean
    DatumHealthCheck datumPdfHealthCheck(PdfService service, PdfRuntime runtime) {
        return DatumHealthCheck.of("pdf", () -> status(service, runtime));
    }

    /** The {@code pdf} capability ({@code signing}, {@code seal}, {@code timestamp} in {@code info.datum}), over the service bean. */
    @Bean
    DatumCapability datumPdfCapability(PdfService service) {
        return DatumCapability.of("pdf")
            .withDetail("signing", () -> service.signer() != null)
            .withDetail("seal", () -> service.sealPreset().enabled())
            .withDetail("timestamp", () -> switch (service.timestampSource()) {
                case "" -> "none";
                case "site" -> "site";
                case "custom" -> "custom";
                default -> "server";
            });
    }

    /**
     * Says which {@code datum.pdf.signing.tsa.*} settings the application's own Timestamper leaves unused: the
     * URL and the credentials at INFO, the reqPolicy at WARN, because an operator who names a policy (a qualified service's)
     * would otherwise believe it is asked for while the tokens are issued under whatever policy the bean uses.
     */
    private static void unusedTimestampSettings(PdfSettings.Tsa tsa) {
        List<String> unused = new ArrayList<>();
        if (named(tsa.url())) {
            unused.add("url");
        }
        if (named(tsa.bearerToken())) {
            unused.add("bearer-token");
        }
        if (named(tsa.basicUser()) || named(tsa.basicPassword())) {
            unused.add("basic-user/basic-password");
        }
        if (named(tsa.policy())) {
            LOG.warn("Datum PDF: seals are timestamped by the application's Timestamper bean, which does not use "
                + "datum.pdf.signing.tsa.policy ({}): the tokens carry the policy that bean asks for, if any.", tsa.policy());
        }
        if (!unused.isEmpty()) {
            LOG.info("Datum PDF: seals are timestamped by the application's Timestamper bean; datum.pdf.signing.tsa.{} not used.",
                String.join(", datum.pdf.signing.tsa.", unused) + (unused.size() == 1 ? " is" : " are"));
        }
    }

    private static boolean named(String value) {
        return value != null && !value.isBlank();
    }

    /**
     * The {@link Timestamper} beans other than the in-process authority: none (null), one, or the primary among several
     * ({@code ObjectProvider.getIfUnique}, Spring's rule); several with no primary stop the start rather than seal with
     * a guess.
     */
    private static Timestamper timestamper(ObjectProvider<Timestamper> timestampers) {
        List<Timestamper> named = timestampers.orderedStream().filter(one -> !(one instanceof TimestampAuthority)).toList();
        if (named.size() <= 1) {
            return named.isEmpty() ? null : named.get(0);
        }
        Timestamper primary = timestampers.getIfUnique();
        if (primary != null && !(primary instanceof TimestampAuthority)) {
            return primary;
        }
        throw new IllegalStateException("Datum PDF: " + named.size() + " Timestamper beans could seal PDFs; define one, or mark one @Primary.");
    }

    /**
     * The HTTP that reaches the named timestamp server, chosen by conditions so the {@code --debug}
     * condition report shows which one was: on Spring's {@code RestClient} when the
     * application has a {@code RestClient.Builder} (Boot's REST client support, with its customisers, observation and
     * metrics, the request factory's proxy and timeouts, and {@code datum.pdf.signing.tsa.ssl-bundle} for TLS), else the
     * JDK's client (with the bundle's {@code SSLContext}). An application's own {@link TsaTransport} bean replaces both.
     * The REST client branch is nested so an application without {@code spring-web} or {@code spring-boot-http-client}
     * never loads it; this class is ordered after Boot's two auto-configurations that create the builder and the
     * request-factory settings, so {@code @ConditionalOnBean} sees them.
     */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnProperty(prefix = "datum.pdf.signing.tsa", name = "url")
    static class TsaTransportConfiguration {

        @Configuration(proxyBeanMethods = false)
        @ConditionalOnClass({RestClient.class, ClientHttpRequestFactoryBuilder.class})
        @ConditionalOnBean(RestClient.Builder.class)
        static class RestClientConfiguration {

            @Bean
            @ConditionalOnMissingBean(TsaTransport.class)
            TsaTransport datumPdfTsaTransport(DatumPdfProperties properties, ObjectProvider<SslBundles> bundles,
                                              RestClient.Builder builder, ObjectProvider<ClientHttpRequestFactoryBuilder<?>> factories,
                                              ObjectProvider<HttpClientSettings> settings,
                                              ObjectProvider<SimpleAsyncTaskExecutorBuilder> executors,
                                              ObjectProvider<TaskDecorator> taskDecorators,
                                              ObjectProvider<io.micrometer.observation.ObservationRegistry> observations) {
                SslBundle bundle = sslBundle(properties, bundles);
                return restClientTransport(builder, factories.getIfAvailable(ClientHttpRequestFactoryBuilder::detect),
                    settings.getIfAvailable(HttpClientSettings::defaults), bundle, properties.getSigning().getTsa().getTimeout(),
                    transportExecutor(executors.getIfAvailable(SimpleAsyncTaskExecutorBuilder::new), taskDecorators.orderedStream().toList(),
                        observations.getIfAvailable()));
            }
        }

        /**
         * The thread each TSA call runs on: from
         * Spring Boot's {@code SimpleAsyncTaskExecutorBuilder} bean, so {@code spring.threads.virtual.enabled} gives a virtual
         * thread and its customizers apply, then held to what the deadline contract needs, re-applied after them: one thread
         * per call started at once (no concurrency limit: a call must never queue behind stalled ones past its deadline),
         * daemon threads, platform or virtual when enabled (an abandoned call never holds the JVM open), named {@code datum-tsa-transport-<n>}. The
         * application's {@code TaskDecorator} beans run, in their order, around Datum's own, which carries the caller's MDC and
         * current observation to the call ({@link TsaCallContext}), so RestClient's observation of the call is a child of the
         * seal that asked.
         */
        static org.springframework.core.task.SimpleAsyncTaskExecutor transportExecutor(SimpleAsyncTaskExecutorBuilder builder,
                                                                                    List<TaskDecorator> applications,
                                                                                    io.micrometer.observation.ObservationRegistry registry) {
            List<TaskDecorator> decorators = new ArrayList<>();
            decorators.add(new TsaCallContext(registry));
            decorators.addAll(applications);
            org.springframework.core.task.SimpleAsyncTaskExecutor executor = builder.build();
            executor.setThreadNamePrefix(RestClientTsaTransport.THREAD_PREFIX);
            executor.setDaemon(true);
            executor.setConcurrencyLimit(org.springframework.util.ConcurrencyThrottleSupport.UNBOUNDED_CONCURRENCY);
            executor.setTaskDecorator(decorators.size() == 1 ? decorators.get(0)
                : new org.springframework.core.task.support.CompositeTaskDecorator(decorators));
            return executor;
        }

        @Bean
        @ConditionalOnMissingBean(TsaTransport.class)
        TsaTransport datumPdfJdkTsaTransport(DatumPdfProperties properties, ObjectProvider<SslBundles> bundles) {
            SslBundle bundle = sslBundle(properties, bundles);
            HttpClient.Builder http = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).connectTimeout(Duration.ofSeconds(5));
            if (bundle != null) {
                http.sslContext(bundle.createSslContext());
            }
            return new JdkTsaTransport(http.build());
        }

        private static SslBundle sslBundle(DatumPdfProperties properties, ObjectProvider<SslBundles> bundles) {
            String bundleName = properties.getSigning().getTsa().getSslBundle();
            if (bundleName == null) {
                return null;
            }
            SslBundles registry = bundles.getIfAvailable();
            if (registry == null) {
                throw new DatumConfigurationException("datum.pdf.signing.tsa.ssl-bundle", "datum.pdf.signing.tsa.ssl-bundle names the SSL bundle \"" + bundleName
                    + "\", but this application has no SSL bundles: define it under spring.ssl.bundle.jks.<name> or .pem.<name>.");
            }
            try {
                return registry.getBundle(bundleName);
            } catch (NoSuchSslBundleException e) {
                throw new DatumConfigurationException("datum.pdf.signing.tsa.ssl-bundle", "datum.pdf.signing.tsa.ssl-bundle names the SSL bundle \"" + bundleName
                    + "\", which is not defined under spring.ssl.bundle.*.", e);
            }
        }

        /**
         * The request factory comes from the framework's builder with the application's {@code spring.http.client.*}
         * settings, except that redirects are never followed (a credential goes to the URL named and nowhere else) and
         * the bundle, when named, is the TLS settings. Boot configures the factory builder and settings, and
         * {@code RestClient.Builder} with them, in imperative (servlet) applications only; in a reactive application the
         * application declares its own prototype {@code RestClient.Builder} bean to opt in, and the factory comes from
         * {@code ClientHttpRequestFactoryBuilder.detect()} with default settings.
         */
        private static TsaTransport restClientTransport(RestClient.Builder builder, ClientHttpRequestFactoryBuilder<?> factories,
                                                        HttpClientSettings base, SslBundle bundle, Duration timeout,
                                                        java.util.concurrent.Executor executor) {
            HttpClientSettings settings = base.withRedirects(HttpRedirects.DONT_FOLLOW);
            if (bundle != null) {
                settings = settings.withSslBundle(bundle);
            }
            // The transport abandons a call at the TSA timeout, but only the factory's read timeout ends the thread and frees
            // the pooled connection, so a stalled server must never leave a read unbounded: the TSA timeout is the ceiling
            // (a shorter spring.http.client.read-timeout wins), and a connect timeout is always set.
            Duration read = settings.readTimeout();
            if (timeout != null && (read == null || read.compareTo(timeout) > 0)) {
                settings = settings.withReadTimeout(timeout);
            }
            if (settings.connectTimeout() == null) {
                settings = settings.withConnectTimeout(Duration.ofSeconds(5));
            }
            // A clone, so an application's own (singleton) builder bean is never switched to the TSA's factory.
            return new RestClientTsaTransport(builder.clone().requestFactory(factories.build(settings)).build(), executor);
        }
    }

    /** The web endpoints on MVC or WebFlux, one switch each under {@code datum.web.api.endpoints.*}. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication
    @Import(PdfWebConfiguration.class)
    static class WebEndpointsConfiguration {
    }

    // ------------------------------------------------------------------------------------------------- helpers

    /**
     * UP while PDFs can be made now (no run: the cached ABI gate). A permanent platform fact (the bytecode runner, no
     * PDF program) is UP with {@code available:false} and the reason: DOWN is for outages, and would make a readiness
     * probe restart a pod for ever where nothing can fix it. DOWN, naming why, when the runtime is down or its probe
     * failed.
     */
    private static DatumHealthContributors.Status status(PdfService service, PdfRuntime runtime) {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("engine", runtime.engine().id());
        details.put("engineMode", runtime.engine().mode());
        String permanent = runtime.permanentlyUnavailable();
        if (permanent != null) {
            details.put("available", false);
            details.put("reason", permanent);
            return DatumHealthContributors.Status.up(details);
        }
        try {
            service.requireAvailable();
        } catch (RuntimeException e) {
            return DatumHealthContributors.Status.down(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        }
        details.put("available", true);
        details.put("signing", service.signer() != null);
        details.put("sealing", service.sealPreset().enabled());
        return DatumHealthContributors.Status.up(details);
    }

    private static TimestampClient timestampClient(PdfSettings.Tsa tsa, TsaTransport transport) {
        TimestampClient.Credentials credentials = null;
        if (tsa.bearerToken() != null && !tsa.bearerToken().isBlank()) {
            credentials = new TimestampClient.Bearer(tsa.bearerToken());
        } else if (tsa.basicUser() != null && !tsa.basicUser().isBlank()) {
            credentials = new TimestampClient.Basic(tsa.basicUser(), tsa.basicPassword() == null ? "" : tsa.basicPassword());
        }
        try {
            return new TimestampClient(URI.create(tsa.url().strip()), tsa.timeout(), credentials, transport == null ? new JdkTsaTransport() : transport,
                tsa.policy());
        } catch (IllegalArgumentException e) {
            throw new DatumConfigurationException("datum.pdf.signing.tsa", "datum.pdf.signing.tsa: " + e.getMessage(), e);
        }
    }
}
