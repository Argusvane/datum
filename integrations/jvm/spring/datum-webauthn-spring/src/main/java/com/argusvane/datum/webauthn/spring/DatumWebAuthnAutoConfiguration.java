package com.argusvane.datum.webauthn.spring;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.core.DatumEventPublisher;
import com.argusvane.datum.forms.spring.DatumFormsAutoConfiguration;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import com.argusvane.datum.springweb.spring.ConditionalOnDatumDataSource;
import com.argusvane.datum.springweb.spring.DatumDataSource;
import com.argusvane.datum.springweb.spring.DatumDataSources;
import com.argusvane.datum.springweb.spring.DatumStoreJdbc;
import com.argusvane.datum.springweb.spring.JdbcSchemaInitializer;
import com.argusvane.datum.springweb.spring.SpringEventPublisher;
import com.argusvane.datum.web.monitoring.DatumCapability;
import com.argusvane.datum.web.monitoring.DatumHealthCheck;
import com.argusvane.datum.webauthn.ChallengeClaims;
import com.argusvane.datum.webauthn.FormSigningSource;
import com.argusvane.datum.webauthn.InMemoryChallengeClaims;
import com.argusvane.datum.webauthn.InMemoryPasskeyRepository;
import com.argusvane.datum.webauthn.InMemoryPasskeyUseStore;
import com.argusvane.datum.webauthn.PasskeyChallenges;
import com.argusvane.datum.webauthn.PasskeyRepository;
import com.argusvane.datum.webauthn.PasskeySettings;
import com.argusvane.datum.webauthn.PasskeySubjectResolver;
import com.argusvane.datum.webauthn.PasskeyUseStore;
import com.argusvane.datum.webauthn.PropertiesFormSigningSource;
import com.argusvane.datum.webauthn.RegistrationCeremony;
import com.argusvane.datum.webauthn.RegistrationCustomizer;
import com.argusvane.datum.webauthn.RegistrationValidator;
import com.argusvane.datum.webauthn.SignatureCheckCustomizer;
import com.argusvane.datum.webauthn.SubmissionSignatureVerifier;
import com.argusvane.datum.webauthn.WebAuthnSettings;
import com.argusvane.datum.webauthn.WebAuthnVerifier;
import com.argusvane.datum.webauthn.submissions.PasskeySignatureCheck;
import com.argusvane.datum.webauthn.submissions.PublishingSignatureCheck;
import com.argusvane.datum.webauthn.web.PasskeyThrottle;
import com.argusvane.datum.webauthn.web.WebAuthnHealth;
import java.time.Clock;
import java.util.Locale;
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
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.PlatformTransactionManager;

/**
 * Passkeys on Spring Boot: the registration ceremony and the signed-submission verifier (the library in the
 * module's root package), their stores, the receiver's signature check, health and events. The endpoints are {@link DatumWebAuthnWebAutoConfiguration}'s, the OpenAPI group
 * {@link DatumWebAuthnOpenApiAutoConfiguration}'s.
 *
 * <p>Off unless {@code datum.webauthn.enabled=true}: a host that does not ask has none of these beans. Every bean
 * is replaceable by an application bean of the same type. The stores come from the {@code datum_passkey},
 * {@code datum_passkey_use} and {@code datum_passkey_challenge} tables when the application has one
 * {@code DataSource} (run {@code V400__datum_webauthn.sql}); without them the in-memory stores are used
 * <em>only</em> when {@code datum.webauthn.allow-memory-stores=true} acknowledges single-instance use. The replay
 * guard and the challenge claims in memory are one per process, so a second instance would accept a signed
 * document again: the start is refused, naming the fix, instead of
 * warning.
 *
 * <p>The start also refuses a relying-party id or an origin the browser would reject, and a secret shorter than 32
 * bytes. Passkeys that are not set up (no {@code rp-id} or {@code origins}) do not stop the start: the endpoints
 * answer 503 {@code signing.not_set_up} and the health check is DOWN (nothing is taken from the request's Host
 * header, which a client controls).
 *
 * <p>The Spring binding of the passkey library: the checks are {@link PasskeySettings}'s, the SQL
 * stores are this module's, on Spring's JDBC, each call a transaction of its own under the application's
 * transaction manager when that is its only one and a JDBC manager of the data source ({@link DatumStoreJdbc}), and
 * events go through the {@code datumEventPublisher} bean ({@link SpringEventPublisher#of}).
 */
@AutoConfiguration(after = {DatumWebAutoConfiguration.class, DatumFormsAutoConfiguration.class}, afterName = {
    "org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration",
    "org.springframework.boot.jdbc.autoconfigure.JdbcTemplateAutoConfiguration",
    "com.argusvane.datum.submissions.spring.DatumSubmissionsAutoConfiguration"
})
@ConditionalOnProperty(prefix = "datum", name = "enabled", matchIfMissing = true)
@ConditionalOnProperty(prefix = "datum.webauthn", name = "enabled", havingValue = "true")
@EnableConfigurationProperties(DatumWebAuthnProperties.class)
public final class DatumWebAuthnAutoConfiguration {

    private static final Logger LOG = LoggerFactory.getLogger("datum.webauthn");

    // ============================================================================================ settings

    /** {@code datum.webauthn.*} as the library reads it. */
    @Bean
    @ConditionalOnMissingBean
    PasskeySettings datumPasskeySettings(DatumWebAuthnProperties properties) {
        return properties.toSettings();
    }

    @Bean
    @ConditionalOnMissingBean
    WebAuthnSettings datumWebAuthnSettings(PasskeySettings settings, Environment environment) {
        return settings.webAuthnSettings(environment.getProperty("spring.application.name", ""));
    }

    @Bean
    @ConditionalOnMissingBean
    WebAuthnVerifier datumWebAuthnVerifier() {
        return new WebAuthnVerifier();
    }

    @Bean
    @ConditionalOnMissingBean
    FormSigningSource datumFormSigningSource(PasskeySettings settings) {
        return new PropertiesFormSigningSource(settings);
    }

    // ============================================================================================ stores

    /**
     * The SQL stores, with one {@code DataSource} to take (the one marked {@code @DatumDataSource}, else the single or primary
     * one; two plain databases need a choice) and Spring's JDBC. The module's tables are made first when
     * {@code datum.jdbc.initialize-schema} asks and they are missing; the script makes all three, so the second and third
     * store find the first's and run nothing.
     */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass({DataSource.class, JdbcClient.class})
    @ConditionalOnDatumDataSource
    static class Jdbc {

        @Bean
        @ConditionalOnMissingBean(PasskeyRepository.class)
        @DependsOnDatabaseInitialization
        JdbcPasskeyRepository datumJdbcPasskeyRepository(@DatumDataSource ObjectProvider<DataSource> datumDataSource,
                                                         ObjectProvider<DataSource> dataSource, ObjectProvider<JdbcSchemaInitializer> schema,
                                                         ObjectProvider<PlatformTransactionManager> transactions) {
            DataSource chosen = DatumDataSources.prepare(datumDataSource, dataSource, schema, JdbcSchemaInitializer.Schema.WEBAUTHN);
            return new JdbcPasskeyRepository(DatumStoreJdbc.forApplication(chosen, transactions));
        }

        /**
         * The SQL replay guard goes with the SQL passkey store only: {@code record()} locks and moves rows of
         * {@code datum_passkey}, which an application's own repository (JPA, another table) never wrote, so every
         * valid signature would be refused as revoked. Failing here says so at start; the in-memory pairing is
         * refused the same way. Each record and release is one new transaction (under the application's
         * transaction manager only when it manages this data source, else the store's own, so the row lock never
         * runs in auto-commit), joining no transaction of the caller.
         */
        @Bean
        @ConditionalOnMissingBean(PasskeyUseStore.class)
        @DependsOnDatabaseInitialization
        JdbcPasskeyUseStore datumJdbcPasskeyUseStore(@DatumDataSource ObjectProvider<DataSource> datumDataSource,
                                                     ObjectProvider<DataSource> dataSource, ObjectProvider<JdbcSchemaInitializer> schema,
                                                     ObjectProvider<PlatformTransactionManager> transactions, PasskeyRepository repository) {
            if (!(repository instanceof JdbcPasskeyRepository)) {
                throw new DatumConfigurationException(null, "The SQL replay guard works over the SQL passkey store (datum_passkey) only, and this "
                    + "application defines its own PasskeyRepository. Define a PasskeyUseStore bean that goes with your PasskeyRepository.",
                    "Define a PasskeyUseStore bean that goes with your PasskeyRepository.");
            }
            DataSource chosen = DatumDataSources.prepare(datumDataSource, dataSource, schema, JdbcSchemaInitializer.Schema.WEBAUTHN);
            return new JdbcPasskeyUseStore(DatumStoreJdbc.forApplication(chosen, transactions));
        }

        @Bean
        @ConditionalOnMissingBean(ChallengeClaims.class)
        @DependsOnDatabaseInitialization
        JdbcChallengeClaims datumJdbcChallengeClaims(@DatumDataSource ObjectProvider<DataSource> datumDataSource,
                                                     ObjectProvider<DataSource> dataSource, ObjectProvider<JdbcSchemaInitializer> schema,
                                                     ObjectProvider<PlatformTransactionManager> transactions) {
            DataSource chosen = DatumDataSources.prepare(datumDataSource, dataSource, schema, JdbcSchemaInitializer.Schema.WEBAUTHN);
            return new JdbcChallengeClaims(DatumStoreJdbc.forApplication(chosen, transactions));
        }
    }

    /**
     * The in-memory fallbacks. Each refuses to be made unless {@code datum.webauthn.allow-memory-stores=true}: a
     * memory store is one per process, so a second instance would not share it.
     */
    @Bean
    @ConditionalOnMissingBean(PasskeyRepository.class)
    InMemoryPasskeyRepository datumInMemoryPasskeyRepository(PasskeySettings settings) {
        settings.acknowledgeMemoryStore("passkey store (datum_passkey)", "passkeys are lost at every restart and one per instance");
        return new InMemoryPasskeyRepository();
    }

    @Bean
    @ConditionalOnMissingBean(PasskeyUseStore.class)
    PasskeyUseStore datumInMemoryPasskeyUseStore(PasskeySettings settings, PasskeyRepository repository) {
        settings.acknowledgeMemoryStore("replay guard (datum_passkey_use)",
            "a second instance accepts the same signed document again, and a restart forgets every signed digest");
        if (!(repository instanceof InMemoryPasskeyRepository memory)) {
            throw new DatumConfigurationException(null, "The in-memory replay guard works over the in-memory passkey store only. Define a "
                + "PasskeyUseStore bean that goes with your PasskeyRepository, or use the SQL stores (a DataSource bean and V400__datum_webauthn.sql).",
                "Define a PasskeyUseStore bean that goes with your PasskeyRepository, or use the SQL stores (a DataSource bean; "
                    + "datum.jdbc.initialize-schema or V400__datum_webauthn.sql makes the tables).");
        }
        return new InMemoryPasskeyUseStore(memory);
    }

    @Bean
    @ConditionalOnMissingBean(ChallengeClaims.class)
    ChallengeClaims datumInMemoryChallengeClaims(PasskeySettings settings) {
        settings.acknowledgeMemoryStore("challenge claims (datum_passkey_challenge)", "a second instance lets a registration challenge be used again");
        return new InMemoryChallengeClaims();
    }

    // ============================================================================================ the library

    @Bean
    @ConditionalOnMissingBean
    PasskeyChallenges datumPasskeyChallenges(PasskeySettings settings, WebAuthnSettings ceremony, ChallengeClaims claims,
                                             ObjectProvider<Clock> clock) {
        byte[] secret = settings.secretBytes();
        java.time.Duration ttl = settings.checkedChallengeTtl();
        // The checked settings (WebAuthnSettings), so a challenge skew outside its bounds stops the start naming the property.
        return new PasskeyChallenges(secret, clock.getIfAvailable(Clock::systemUTC), claims, ttl, ceremony.challengeSkew());
    }

    /**
     * The registration ceremony. The application's {@link RegistrationCustomizer} and {@link RegistrationValidator} beans
     * are collected in the framework's order ({@code @Order}; equal orders keep registration order).
     */
    @Bean
    @ConditionalOnMissingBean
    RegistrationCeremony datumRegistrationCeremony(WebAuthnSettings settings, PasskeyChallenges challenges, PasskeyRepository passkeys,
                                                   WebAuthnVerifier verifier, ObjectProvider<Clock> clock,
                                                   ObjectProvider<RegistrationCustomizer> customizers, ObjectProvider<RegistrationValidator> validators) {
        return new RegistrationCeremony(settings, challenges, passkeys, verifier, clock.getIfAvailable(Clock::systemUTC),
            customizers.orderedStream().toList(), validators.orderedStream().toList());
    }

    /**
     * The verdict on a submission's passkey signature. The application's {@link SignatureCheckCustomizer} beans
     * are collected in the framework's order ({@code @Order}; equal orders keep registration order).
     */
    @Bean
    @ConditionalOnMissingBean
    SubmissionSignatureVerifier datumSubmissionSignatureVerifier(WebAuthnSettings settings, PasskeyRepository passkeys, PasskeyUseStore uses,
                                                                 WebAuthnVerifier verifier, ObjectProvider<Clock> clock,
                                                                 ObjectProvider<SignatureCheckCustomizer> customizers) {
        return new SubmissionSignatureVerifier(settings, passkeys, uses, verifier, clock.getIfAvailable(Clock::systemUTC),
            customizers.orderedStream().toList());
    }

    // ============================================================================================ who is asking

    /** Spring Security's principal, when Spring Security is on the class path. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(name = "org.springframework.security.core.Authentication")
    static class Security {

        @Bean
        @ConditionalOnMissingBean(PasskeySubjectResolver.class)
        PasskeySubjectResolver datumSecurityPrincipalSubjectResolver() {
            return new SecurityPrincipalSubjectResolver();
        }
    }

    /** Without Spring Security, a request's plain principal (a container's) names the owner; no principal is a visitor. */
    @Bean
    @ConditionalOnMissingBean(PasskeySubjectResolver.class)
    PasskeySubjectResolver datumPrincipalNameSubjectResolver() {
        return PasskeySubjectResolver.byPrincipalName();
    }

    // ============================================================================================ throttle

    /** datum-submissions' throttle counts passkey requests too (kind REGISTER), when that jar and its bean are here. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(name = "com.argusvane.datum.submissions.spi.SubmissionThrottle")
    static class SubmissionsThrottle {

        @Bean
        @ConditionalOnBean(com.argusvane.datum.submissions.spi.SubmissionThrottle.class)
        @ConditionalOnMissingBean(PasskeyThrottle.class)
        PasskeyThrottle datumPasskeyThrottle(com.argusvane.datum.submissions.spi.SubmissionThrottle throttle) {
            return new SubmissionsPasskeyThrottle(throttle);
        }
    }

    @Bean
    @ConditionalOnMissingBean(PasskeyThrottle.class)
    PasskeyThrottle datumNoPasskeyThrottle() {
        LOG.warn("datum.webauthn has no throttle (datum-submissions' SubmissionThrottle is not here and no PasskeyThrottle bean is defined): "
            + "challenges and registrations are not limited per address.");
        return PasskeyThrottle.NONE;
    }

    // ============================================================================================ the receiver's seam

    /** The receiver's signature check, only when datum-submissions is on the class path. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(name = "com.argusvane.datum.submissions.spi.SubmissionSignatureCheck")
    static class Receiver {

        @Bean
        @ConditionalOnMissingBean(com.argusvane.datum.submissions.spi.SubmissionSignatureCheck.class)
        com.argusvane.datum.submissions.spi.SubmissionSignatureCheck datumPasskeySignatureCheck(
            SubmissionSignatureVerifier verifier, WebAuthnSettings settings, FormSigningSource forms, PasskeySubjectResolver subjects,
            ObjectProvider<DatumEventPublisher> publisher, org.springframework.context.ApplicationEventPublisher events) {
            return new PublishingSignatureCheck(new PasskeySignatureCheck(verifier, settings, forms, subjects), SpringEventPublisher.of(publisher, events));
        }
    }

    // ============================================================================================ health

    /**
     * The {@code datum-webauthn} check's state. Replaceable, and each store is named by what it is: Datum's
     * in-memory class is {@code memory}, Datum's SQL class {@code jdbc}, anything else {@code custom}, whatever its name (an
     * application's {@code JdbcTenantPasskeyRepository} is not Datum's JDBC store).
     */
    @Bean
    @ConditionalOnMissingBean
    WebAuthnHealth datumWebAuthnHealth(WebAuthnSettings settings, PasskeyRepository passkeys, PasskeyUseStore uses, ChallengeClaims claims,
                                       PasskeySettings passkeySettings) {
        return new WebAuthnHealth(settings,
            store(passkeys instanceof InMemoryPasskeyRepository, passkeys instanceof JdbcPasskeyRepository),
            store(uses instanceof InMemoryPasskeyUseStore, uses instanceof JdbcPasskeyUseStore),
            store(claims instanceof InMemoryChallengeClaims, claims instanceof JdbcChallengeClaims),
            passkeySettings.passkeys().name().toLowerCase(Locale.ROOT));
    }

    /** The {@code datum-webauthn} health check ({@code datum/datum-webauthn}), over the {@link WebAuthnHealth} bean. */
    @Bean
    DatumHealthCheck datumWebAuthnHealthCheck(WebAuthnHealth health) {
        return DatumHealthCheck.of(WebAuthnHealth.NAME, health::status);
    }

    /** The {@code webauthn} capability and its endpoint base for {@code host.json}, from the settings bean. */
    @Bean
    DatumCapability datumWebAuthnCapability(PasskeySettings passkeySettings) {
        return DatumCapability.of("webauthn").withEndpoint("webauthn", passkeySettings.path());
    }

    private static String store(boolean memory, boolean jdbc) {
        return memory ? "memory" : jdbc ? "jdbc" : "custom";
    }
}
