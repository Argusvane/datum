package com.argusvane.datum.webauthn.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.springweb.spring.DatumStoreJdbc;
import com.argusvane.datum.submissions.spi.SubmissionSignatureCheck;
import com.argusvane.datum.submissions.spi.SubmissionThrottle;
import com.argusvane.datum.submissions.spi.ThrottleDecision;
import com.argusvane.datum.web.monitoring.DatumHealthContributors;
import com.argusvane.datum.webauthn.ChallengeClaims;
import com.argusvane.datum.webauthn.FormSigning;
import com.argusvane.datum.webauthn.FormSigningSource;
import com.argusvane.datum.webauthn.InMemoryChallengeClaims;
import com.argusvane.datum.webauthn.InMemoryPasskeyRepository;
import com.argusvane.datum.webauthn.PasskeyChallenges;
import com.argusvane.datum.webauthn.PasskeyRepository;
import com.argusvane.datum.webauthn.PasskeySubject;
import com.argusvane.datum.webauthn.PasskeySubjectResolver;
import com.argusvane.datum.webauthn.PasskeyUseStore;
import com.argusvane.datum.webauthn.submissions.PublishingSignatureCheck;
import com.argusvane.datum.webauthn.spring.SubmissionsPasskeyThrottle;
import com.argusvane.datum.webauthn.web.PasskeyThrottle;
import com.argusvane.datum.webauthn.web.WebAuthnHealth;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.assertj.AssertableApplicationContext;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.transaction.PlatformTransactionManager;

/**
 * The auto-configuration without a web stack: what switches it on, the multi-process policy for the stores (the
 * in-memory ones are refused unless acknowledged; SQL ones are chosen when there is one {@code DataSource}),
 * the start-time checks (origins, relying-party id, secret), per-form signing settings, and the seam beans.
 */
class DatumWebAuthnAutoConfigurationTest {

    private static final String SECRET = "a configured secret of at least 32 bytes!";

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(DatumWebAuthnAutoConfiguration.class));

    private ApplicationContextRunner enabled() {
        return runner.withPropertyValues("datum.webauthn.enabled=true", "datum.webauthn.rp-id=example.org", "datum.webauthn.rp-name=Example",
            "datum.webauthn.origins=https://forms.example.org", "datum.webauthn.secret=" + SECRET);
    }

    private static JdbcTemplate migrated() {
        DriverManagerDataSource source = new DriverManagerDataSource("jdbc:h2:mem:" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1", "sa", "");
        new ResourceDatabasePopulator(new ClassPathResource("META-INF/datum/db/migration/h2/V400__datum_webauthn.sql")).execute(source);
        return new JdbcTemplate(source);
    }

    private static String failure(AssertableApplicationContext context) {
        Throwable failure = context.getStartupFailure();
        assertThat(failure).as("the start was refused").isNotNull();
        StringBuilder text = new StringBuilder();
        for (Throwable cause = failure; cause != null; cause = cause.getCause()) {
            text.append(cause.getMessage()).append('\n');
        }
        return text.toString();
    }

    // ------------------------------------------------------------------------------------------ registration hooks

    /** Registration hook beans declared against their {@code @Order}. */
    @org.springframework.context.annotation.Configuration(proxyBeanMethods = false)
    static class RegistrationHookBeans {

        static final java.util.List<String> CALLS = java.util.Collections.synchronizedList(new java.util.ArrayList<>());

        @org.springframework.context.annotation.Bean
        @org.springframework.core.annotation.Order(2)
        com.argusvane.datum.webauthn.RegistrationCustomizer refusesSecond() {
            return draft -> {
                CALLS.add("second:" + draft.step() + ":" + draft.label());
                if ("blocked".equals(draft.asking().uid())) {
                    throw com.argusvane.datum.core.hooks.HookRefusedException.forbidden("passkey.tenant", "Not offered to you.");
                }
            };
        }

        @org.springframework.context.annotation.Bean
        @org.springframework.core.annotation.Order(1)
        com.argusvane.datum.webauthn.RegistrationCustomizer labelsFirst() {
            return draft -> {
                CALLS.add("first:" + draft.step());
                draft.label("Work key");
            };
        }

        @org.springframework.context.annotation.Bean
        com.argusvane.datum.webauthn.RegistrationValidator noValidatorRunsAtTheChallenge() {
            return (context, asking, passkey) -> {
                CALLS.add("validator");
                return java.util.List.of();
            };
        }
    }

    /** Signature-check hook beans declared against their {@code @Order}. */
    @org.springframework.context.annotation.Configuration(proxyBeanMethods = false)
    static class SignatureHookBeans {

        static final com.argusvane.datum.webauthn.SignatureCheckCustomizer SECOND = draft -> { };
        static final com.argusvane.datum.webauthn.SignatureCheckCustomizer FIRST = draft -> draft.userVerificationRequired(true);

        @org.springframework.context.annotation.Bean
        @org.springframework.core.annotation.Order(2)
        com.argusvane.datum.webauthn.SignatureCheckCustomizer second() {
            return SECOND;
        }

        @org.springframework.context.annotation.Bean
        @org.springframework.core.annotation.Order(1)
        com.argusvane.datum.webauthn.SignatureCheckCustomizer first() {
            return FIRST;
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void theApplicationsSignatureCheckHooksAreTheVerifiersInTheirOrder() {
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true").withUserConfiguration(SignatureHookBeans.class).run(context -> {
            assertThat(context).hasNotFailed();
            Object verifier = context.getBean(com.argusvane.datum.webauthn.SubmissionSignatureVerifier.class);
            java.lang.reflect.Field field = verifier.getClass().getDeclaredField("customizers");
            field.setAccessible(true);
            assertThat((java.util.List<Object>) field.get(verifier)).containsExactly(SignatureHookBeans.FIRST, SignatureHookBeans.SECOND);
        });
    }

    @Test
    void theApplicationsRegistrationHooksAreTheCeremonysInTheirOrder() {
        RegistrationHookBeans.CALLS.clear();
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true").withUserConfiguration(RegistrationHookBeans.class).run(context -> {
            assertThat(context).hasNotFailed();
            com.argusvane.datum.webauthn.RegistrationCeremony ceremony = context.getBean(com.argusvane.datum.webauthn.RegistrationCeremony.class);
            com.argusvane.datum.webauthn.PasskeySubject ada = new com.argusvane.datum.webauthn.PasskeySubject("7", "ada", "Ada");
            com.argusvane.datum.webauthn.RegistrationOptions options = ceremony.challenge(
                com.argusvane.datum.webauthn.PasskeyContext.forAccount(ada, "Passkey"), ada, "Phone");
            assertThat(options.user().name()).isEqualTo("Work key");
            assertThat(RegistrationHookBeans.CALLS).containsExactly("first:CHALLENGE", "second:CHALLENGE:Work key");

            com.argusvane.datum.webauthn.PasskeySubject blocked = new com.argusvane.datum.webauthn.PasskeySubject("blocked", "b", "B");
            org.assertj.core.api.Assertions.assertThatThrownBy(() -> ceremony.challenge(
                    com.argusvane.datum.webauthn.PasskeyContext.forAccount(blocked, "Passkey"), blocked, ""))
                .isInstanceOfSatisfying(com.argusvane.datum.core.hooks.HookRefusedException.class,
                    refused -> assertThat(refused.httpStatus()).isEqualTo(403));
        });
    }

    // ------------------------------------------------------------------------------------------ challenge ttl

    @Test
    void theChallengeTtlIsAppliedAndAnOutOfRangeOneRefusesTheStart() {
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true", "datum.webauthn.challenge-ttl=90s").run(context -> {
            assertThat(context).hasNotFailed();
            PasskeyChallenges.IssuedChallenge issued = context.getBean(PasskeyChallenges.class).issue("register", "petition", "", "h");
            assertThat(issued.expires() - java.time.Instant.now().getEpochSecond()).isBetween(88L, 90L);
        });
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true", "datum.webauthn.challenge-ttl=2s").run(context ->
            assertThat(failure(context)).contains("datum.webauthn.challenge-ttl must be between"));
    }

    @Test
    void aKeepYearsOutsideZeroToHundredRefusesTheStartInsteadOfBecomingZero() {
        for (String years : new String[] {"-7", "101"}) {
            enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true", "datum.webauthn.keep-years=" + years).run(context ->
                assertThat(failure(context)).as(years).contains("datum.webauthn.keep-years"));
        }
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true", "datum.webauthn.keep-years=7").run(context -> assertThat(context).hasNotFailed());
    }

    @Test
    void aSigningWindowShorterThanASecondRefusesTheStartInsteadOfBecomingTheDefault() {
        for (String window : new String[] {"0s", "500ms", "-5s"}) {
            enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true", "datum.webauthn.window=" + window).run(context ->
                assertThat(failure(context)).as(window).contains("datum.webauthn.window"));
        }
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true", "datum.webauthn.window=90s").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(com.argusvane.datum.webauthn.WebAuthnSettings.class).window()).isEqualTo(java.time.Duration.ofSeconds(90));
        });
    }

    // ------------------------------------------------------------------------------------------ settings

    /** The four settings bind, reach the ceremony's settings and the challenge, and refuse a value outside their bounds. */
    @Test
    void residentKeyAndTheThreeToleranceSettingsBindAndAreChecked() {
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true", "datum.webauthn.resident-key=Preferred",
            "datum.webauthn.challenge-skew=5s", "datum.webauthn.signed-at-skew=90s", "datum.webauthn.anonymous-grace=2h").run(context -> {
                assertThat(context).hasNotFailed();
                com.argusvane.datum.webauthn.WebAuthnSettings settings = context.getBean(com.argusvane.datum.webauthn.WebAuthnSettings.class);
                assertThat(settings.residentKey()).isEqualTo("preferred");
                assertThat(settings.challengeSkew()).hasSeconds(5);
                assertThat(settings.signedAtSkew()).hasSeconds(90);
                assertThat(settings.anonymousGrace()).hasHours(2);
                assertThat(org.springframework.test.util.ReflectionTestUtils.getField(context.getBean(PasskeyChallenges.class), "skewSeconds"))
                    .isEqualTo(5L);
            });
        for (String[] bad : new String[][] {{"datum.webauthn.resident-key=sometimes", "datum.webauthn.resident-key"},
            {"datum.webauthn.challenge-skew=10m", "datum.webauthn.challenge-skew"}, {"datum.webauthn.signed-at-skew=11m", "datum.webauthn.signed-at-skew"},
            {"datum.webauthn.anonymous-grace=1m", "datum.webauthn.anonymous-grace"}}) {
            enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true", bad[0]).run(context ->
                assertThat(failure(context)).as(bad[0]).contains(bad[1]));
        }
    }

    @Test
    void theDefaultsOfTheFourSettingsAreTheOnesThatWereFixed() {
        com.argusvane.datum.webauthn.PasskeySettings fromProperties = new DatumWebAuthnProperties().toSettings();
        assertThat(fromProperties).isEqualTo(com.argusvane.datum.webauthn.PasskeySettings.defaults());
        assertThat(fromProperties.residentKey()).isEqualTo("required");
        assertThat(fromProperties.challengeSkew()).hasSeconds(60);
        assertThat(fromProperties.signedAtSkew()).hasSeconds(60);
        assertThat(fromProperties.anonymousGrace()).hasHours(24);
    }

    @Test
    void anApplicationsPasskeySettingsBeanReplacesTheOneFromProperties() {
        DatumWebAuthnProperties base = new DatumWebAuthnProperties();
        base.setAllowMemoryStores(true);
        com.argusvane.datum.webauthn.PasskeySettings mine = base.toSettings();
        enabled().withBean(com.argusvane.datum.webauthn.PasskeySettings.class, () -> mine)
            .withPropertyValues("datum.webauthn.window=90s").run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context).hasSingleBean(com.argusvane.datum.webauthn.PasskeySettings.class);
                assertThat(context.getBean(com.argusvane.datum.webauthn.PasskeySettings.class)).isSameAs(mine);
                assertThat(context.getBean(com.argusvane.datum.webauthn.WebAuthnSettings.class).window()).as("the properties did not apply")
                    .isEqualTo(java.time.Duration.ofSeconds(600));
            });
    }

    // ------------------------------------------------------------------------------------------ switches

    @Test
    void offUnlessEnabled() {
        runner.run(context -> assertThat(context).doesNotHaveBean(PasskeyRepository.class).doesNotHaveBean(WebAuthnHealth.class));
        runner.withPropertyValues("datum.webauthn.enabled=false").run(context -> assertThat(context).doesNotHaveBean(WebAuthnHealth.class));
        enabled().withPropertyValues("datum.enabled=false", "datum.webauthn.allow-memory-stores=true")
            .run(context -> assertThat(context).doesNotHaveBean(WebAuthnHealth.class));
    }

    // ------------------------------------------------------------------------------------------ multi-process policy

    @Test
    void anInMemoryStoreIsRefusedWithoutAnAcknowledgement() {
        enabled().run(context -> {
            String text = failure(context);
            assertThat(text).contains("datum.webauthn.allow-memory-stores=true").contains("V400__datum_webauthn.sql");
        });
    }

    @Test
    void anAcknowledgedInMemoryStoreStartsAndSaysSoOnHealth() {
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(PasskeyRepository.class)).isInstanceOf(InMemoryPasskeyRepository.class);
            assertThat(context.getBean(ChallengeClaims.class)).isInstanceOf(InMemoryChallengeClaims.class);
            DatumHealthContributors.Status status = context.getBean(WebAuthnHealth.class).status();
            assertThat(status.up()).isTrue();
            assertThat(status.details()).containsEntry("passkeyStore", "memory").containsEntry("replayStore", "memory")
                .containsEntry("challengeStore", "memory").containsEntry("rpId", "example.org");
        });
    }

    /** An application's store whose class name starts "Jdbc" (a tenant's SQL store): it is not Datum's, so it reads custom. */
    static final class JdbcTenantPasskeyRepository implements PasskeyRepository {

        final InMemoryPasskeyRepository delegate = new InMemoryPasskeyRepository();

        public java.util.Optional<com.argusvane.datum.webauthn.PasskeyRecord> find(String credentialId) {
            return delegate.find(credentialId);
        }

        public java.util.Optional<com.argusvane.datum.webauthn.PasskeyRecord> findById(long id) {
            return delegate.findById(id);
        }

        public boolean keyRegistered(String publicKeyHash) {
            return delegate.keyRegistered(publicKeyHash);
        }

        public java.util.Optional<com.argusvane.datum.webauthn.PasskeyRecord> firstOf(String owner, String formId) {
            return delegate.firstOf(owner, formId);
        }

        public List<com.argusvane.datum.webauthn.PasskeyRecord> ownActive(String owner, String formId) {
            return delegate.ownActive(owner, formId);
        }

        public List<com.argusvane.datum.webauthn.PasskeyRecord> ofOwner(String owner) {
            return delegate.ofOwner(owner);
        }

        public com.argusvane.datum.webauthn.PasskeyRecord create(com.argusvane.datum.webauthn.PasskeyRecord passkey) {
            return delegate.create(passkey);
        }

        public boolean revoke(long id, String by, java.time.Instant at) {
            return delegate.revoke(id, by, at);
        }

        public boolean markRemoved(long id, java.time.Instant at) {
            return delegate.markRemoved(id, at);
        }

        public boolean delete(long id) {
            return delegate.delete(id);
        }

        public boolean touch(long id, long signCount, java.time.Instant at) {
            return delegate.touch(id, signCount, at);
        }
    }

    /**
     * The health detail names a store by what it is ({@code instanceof} Datum's own classes), not by its class
     * name's prefix, so an application's {@code JdbcTenantPasskeyRepository} is {@code custom}, not Datum's JDBC store.
     */
    @Test
    void anApplicationsStoreIsCustomWhateverItsName() {
        JdbcTenantPasskeyRepository tenant = new JdbcTenantPasskeyRepository();
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true")
            .withBean(PasskeyRepository.class, () -> tenant)
            .withBean(PasskeyUseStore.class, () -> new com.argusvane.datum.webauthn.InMemoryPasskeyUseStore(tenant.delegate))
            .run(context -> {
                assertThat(context).hasNotFailed();
                DatumHealthContributors.Status status = context.getBean(WebAuthnHealth.class).status();
                assertThat(status.details()).containsEntry("passkeyStore", "custom").containsEntry("replayStore", "memory")
                    .containsEntry("challengeStore", "memory");
            });
    }

    @org.springframework.context.annotation.Configuration(proxyBeanMethods = false)
    static class OwnHealth {

        @org.springframework.context.annotation.Bean
        WebAuthnHealth applicationHealth(com.argusvane.datum.webauthn.WebAuthnSettings settings) {
            return new WebAuthnHealth(settings, "vault", "vault", "vault", "off");
        }
    }

    /** The passkey health check is replaceable, and the {@code datum-webauthn} check is the application's. */
    @Test
    void anApplicationsWebAuthnHealthReplacesTheBindings() {
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true")
            .withUserConfiguration(OwnHealth.class, MonitoringRegistries.class)
            .run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBeansOfType(WebAuthnHealth.class)).containsOnlyKeys("applicationHealth");
                assertThat(context.getBean(DatumHealthContributors.class).evaluate(WebAuthnHealth.NAME).details())
                    .containsEntry("passkeyStore", "vault");
            });
    }

    @Test
    void aSqlStoreNeedsNoAcknowledgement() {
        enabled().withBean(DataSource.class, () -> migrated().getDataSource()).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(PasskeyRepository.class)).isInstanceOf(JdbcPasskeyRepository.class);
            assertThat(context.getBean(PasskeyUseStore.class)).isInstanceOf(JdbcPasskeyUseStore.class);
            assertThat(context.getBean(ChallengeClaims.class)).isInstanceOf(JdbcChallengeClaims.class);
            assertThat(context.getBean(WebAuthnHealth.class).status().details()).containsEntry("passkeyStore", "jdbc")
                .containsEntry("replayStore", "jdbc").containsEntry("challengeStore", "jdbc");
            // Made after Flyway, Liquibase or spring.sql.init.
            for (String store : java.util.List.of("datumJdbcPasskeyRepository", "datumJdbcPasskeyUseStore", "datumJdbcChallengeClaims")) {
                assertThat(context.getBeanFactory().findAnnotationOnBean(store, org.springframework.boot.sql.init.dependency.DependsOnDatabaseInitialization.class)).as(store).isNotNull();
            }
        });
    }

    @Test
    void anApplicationsOwnStoresBackOffTheDefaultsAndNeedNoAcknowledgement() {
        PasskeyRepository repository = new InMemoryPasskeyRepository();
        enabled().withBean(PasskeyRepository.class, () -> repository)
            .withBean(PasskeyUseStore.class, () -> new com.argusvane.datum.webauthn.InMemoryPasskeyUseStore((InMemoryPasskeyRepository) repository))
            .withBean(ChallengeClaims.class, InMemoryChallengeClaims::new).run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(PasskeyRepository.class)).isSameAs(repository);
                assertThat(context.getBeansOfType(PasskeyRepository.class)).hasSize(1);
            });
    }

    @Test
    void aCustomRepositoryWithoutAUseStoreIsExplained() {
        // Not the library's own class: a repository the application wrote (here, a proxy over the in-memory one).
        InMemoryPasskeyRepository inner = new InMemoryPasskeyRepository();
        PasskeyRepository custom = (PasskeyRepository) java.lang.reflect.Proxy.newProxyInstance(getClass().getClassLoader(),
            new Class<?>[] {PasskeyRepository.class}, (proxy, method, args) -> method.invoke(inner, args));
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true").withBean(PasskeyRepository.class, () -> custom)
            .run(context -> assertThat(failure(context)).contains("Define a PasskeyUseStore bean"));
    }

    @Test
    void theSqlReplayGuardIsNotPairedWithAnApplicationsOwnRepository() {
        // A repository the application wrote (JPA, another table) never wrote the rows the SQL guard locks and moves:
        // every valid signature would be refused as revoked. Say so at start.
        InMemoryPasskeyRepository inner = new InMemoryPasskeyRepository();
        PasskeyRepository custom = (PasskeyRepository) java.lang.reflect.Proxy.newProxyInstance(getClass().getClassLoader(),
            new Class<?>[] {PasskeyRepository.class}, (proxy, method, args) -> method.invoke(inner, args));
        enabled().withBean(DataSource.class, () -> migrated().getDataSource()).withBean(PasskeyRepository.class, () -> custom)
            .run(context -> assertThat(failure(context)).contains("Define a PasskeyUseStore bean").contains("SQL passkey store"));
    }

    /**
     * The stores accept the application's transaction manager only when it manages their DataSource. Each
     * record and release is one new transaction whose statements must run on the manager's connection (JdbcStoresContract's
     * racing tests hold the lock to it), so a transaction manager for another database, which would leave the row
     * lock in auto-commit, is passed over for the stores' own: the store is wired to the one DataSource whatever
     * managers exist.
     */
    @Test
    void theReplayGuardWorksOnItsOwnDatabaseWhateverTransactionManagersExist() {
        JdbcTemplate template = migrated();
        DataSource same = template.getDataSource();
        DataSource other = new DriverManagerDataSource("jdbc:h2:mem:" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1", "sa", "");
        PlatformTransactionManager foreign = new DataSourceTransactionManager(other);

        enabled().withBean(DataSource.class, () -> same).withBean("foreignTransactions", PlatformTransactionManager.class, () -> foreign)
            .run(context -> {
                assertThat(context).hasNotFailed();
                for (Object store : java.util.List.of(context.getBean(JdbcPasskeyUseStore.class), context.getBean(JdbcPasskeyRepository.class),
                    context.getBean(JdbcChallengeClaims.class))) {
                    assertThat(jdbcOf(store).dataSource()).isSameAs(same);
                    assertThat(jdbcOf(store).transactionManager()).isNotSameAs(foreign);
                    assertThat(jdbcOf(store).ownTransactions()).isTrue();
                }
            });
    }

    /** The application's own transaction manager over the stores' DataSource is the one their calls run under. */
    @Test
    void theApplicationsTransactionManagerForTheDataSourceIsUsed() {
        DataSource same = migrated().getDataSource();
        PlatformTransactionManager application = new DataSourceTransactionManager(same);

        enabled().withBean(DataSource.class, () -> same).withBean("transactionManager", PlatformTransactionManager.class, () -> application)
            .run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(jdbcOf(context.getBean(JdbcPasskeyUseStore.class)).transactionManager()).isSameAs(application);
                assertThat(jdbcOf(context.getBean(JdbcPasskeyRepository.class)).transactionManager()).isSameAs(application);
                assertThat(jdbcOf(context.getBean(JdbcChallengeClaims.class)).transactionManager()).isSameAs(application);
            });
    }

    private static DatumStoreJdbc jdbcOf(Object store) {
        return (DatumStoreJdbc) org.springframework.test.util.ReflectionTestUtils.getField(store, "jdbc");
    }

    /** The literal defaults (kept for the configuration metadata) are the library's. */
    @Test
    void thePropertiesDefaultsAreTheSettingsDefaults() {
        assertThat(new DatumWebAuthnProperties().toSettings()).isEqualTo(com.argusvane.datum.webauthn.PasskeySettings.defaults());
    }

    // ------------------------------------------------------------------------------------------ start-time checks

    @Test
    void anOriginThatIsNotWrittenTheWayABrowserSendsItIsRefused() {
        // The verifier compares the client's origin exactly: these would pass the start and then fail every ceremony.
        for (String origin : List.of("https://Forms.Example.org", "HTTPS://forms.example.org", "https://forms.example.org:443",
            "https://forms.example.org.", "http://localhost:80")) {
            String rpId = origin.contains("localhost") ? "localhost" : "example.org";
            enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true", "datum.webauthn.rp-id=" + rpId, "datum.webauthn.origins=" + origin)
                .run(context -> assertThat(failure(context)).as(origin).contains("datum.webauthn.origins").contains("browser"));
        }
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true", "datum.webauthn.origins=https://forms.example.org:8443")
            .run(context -> assertThat(context).as("a non-default port is part of the origin").hasNotFailed());
    }

    @Test
    void anUnparseableOriginIsRefusedAtStartNamingTheProperty() {
        for (String origin : List.of("forms.example.org", "https://forms.example.org/path", "ftp://forms.example.org", "https://", "http://forms.example.org")) {
            enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true", "datum.webauthn.origins=" + origin).run(context ->
                assertThat(failure(context)).as(origin).contains("datum.webauthn.origins"));
        }
    }

    @Test
    void anOriginOutsideTheRelyingPartyIdIsRefused() {
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true", "datum.webauthn.origins=https://evil.example.com")
            .run(context -> assertThat(failure(context)).contains("is not under datum.webauthn.rp-id"));
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true", "datum.webauthn.origins=https://notexample.org")
            .run(context -> assertThat(failure(context)).as("a suffix of the text is not a parent domain").contains("is not under datum.webauthn.rp-id"));
    }

    @Test
    void localhostMayUseHttpAndTheRelyingPartyIdMayBeTheHostItself() {
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true", "datum.webauthn.rp-id=localhost",
            "datum.webauthn.origins=http://localhost:8080,https://localhost").run(context -> assertThat(context).hasNotFailed());
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true", "datum.webauthn.origins=https://example.org,https://forms.example.org:8443/")
            .run(context -> assertThat(context).hasNotFailed());
    }

    @Test
    void aShortSecretIsRefused() {
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true", "datum.webauthn.secret=too short")
            .run(context -> assertThat(failure(context)).contains("datum.webauthn.secret must be at least 32 bytes"));
    }

    @Test
    void noSecretMakesOneAtStart() {
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true", "datum.webauthn.secret=")
            .run(context -> assertThat(context).hasNotFailed().hasSingleBean(com.argusvane.datum.webauthn.PasskeyChallenges.class));
    }

    @Test
    void passkeysThatAreNotSetUpStartButHealthIsDown() {
        runner.withPropertyValues("datum.webauthn.enabled=true", "datum.webauthn.allow-memory-stores=true", "datum.webauthn.secret=" + SECRET)
            .run(context -> {
                assertThat(context).hasNotFailed();
                DatumHealthContributors.Status status = context.getBean(WebAuthnHealth.class).status();
                assertThat(status.up()).isFalse();
                assertThat(status.details().get("reason").toString()).contains("datum.webauthn.rp-id");
            });
    }

    // ------------------------------------------------------------------------------------------ per-form settings

    @Test
    void formsDefaultToOffAndAreSetByDefaultsAndOverrides() {
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true",
            "datum.webauthn.forms.petition.mode=required", "datum.webauthn.forms.petition.statement=I confirm.",
            "datum.webauthn.forms.petition.scope=values", "datum.webauthn.forms.petition.unavailable=accept",
            "datum.webauthn.forms.petition.verify=false", "datum.webauthn.forms.petition.user-verification=required",
            "datum.webauthn.forms.survey.mode=optional", "datum.webauthn.placement=wrapper").run(context -> {
                FormSigningSource source = context.getBean(FormSigningSource.class);
                assertThat(source.forForm("unlisted").mode()).isEqualTo(FormSigning.Mode.OFF);
                FormSigning petition = source.forForm("petition");
                assertThat(petition).extracting(FormSigning::mode, FormSigning::scope, FormSigning::statement, FormSigning::unavailable,
                    FormSigning::verify, FormSigning::userVerification, FormSigning::placement)
                    .containsExactly(FormSigning.Mode.REQUIRED, "values", "I confirm.", "accept", false, "required", "wrapper");
                FormSigning survey = source.forForm("survey");
                assertThat(survey).extracting(FormSigning::mode, FormSigning::scope, FormSigning::verify, FormSigning::unavailable)
                    .containsExactly(FormSigning.Mode.OPTIONAL, "envelope", true, "refuse");
            });
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true", "datum.webauthn.mode=required", "datum.webauthn.passkeys=form")
            .run(context -> {
                assertThat(context.getBean(FormSigningSource.class).forForm("anything").mode()).isEqualTo(FormSigning.Mode.REQUIRED);
                assertThat(context.getBean(com.argusvane.datum.webauthn.WebAuthnSettings.class).perForm()).isTrue();
                assertThat(context.getBean(WebAuthnHealth.class).status().details()).containsEntry("passkeys", "form");
            });
    }

    @Test
    void aWordOutsideASettingsSetStopsTheStartInsteadOfFallingBackToADefault() {
        // mode=requried must not read as "off": the receiver would then accept unsigned submissions to a form meant to be signed.
        Map<String, String> bad = new java.util.LinkedHashMap<>();
        bad.put("datum.webauthn.forms.petition.mode=requried", "datum.webauthn.forms[petition].mode");
        bad.put("datum.webauthn.mode=sometimes", "datum.webauthn.mode");
        bad.put("datum.webauthn.mode=", "datum.webauthn.mode");
        bad.put("datum.webauthn.forms.petition.scope=everything", "datum.webauthn.forms[petition].scope");
        bad.put("datum.webauthn.placement=beside", "datum.webauthn.placement");
        bad.put("datum.webauthn.user-verification=discouraged", "datum.webauthn.user-verification");
        bad.put("datum.webauthn.forms.petition.unavailable=allow", "datum.webauthn.forms[petition].unavailable");
        bad.forEach((setting, property) -> enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true", setting).run(context ->
            assertThat(failure(context)).as(setting).contains(property).contains("not one of")));
    }

    @Test
    void wordsAreReadWithoutCaseAtTheSiteLevelToo() {
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true", "datum.webauthn.user-verification=Required",
            "datum.webauthn.scope= Values ", "datum.webauthn.forms.petition.mode=REQUIRED", "datum.webauthn.unavailable=Accept").run(context -> {
                FormSigning petition = context.getBean(FormSigningSource.class).forForm("petition");
                assertThat(petition).extracting(FormSigning::userVerification, FormSigning::scope, FormSigning::mode, FormSigning::unavailable)
                    .containsExactly("required", "values", FormSigning.Mode.REQUIRED, "accept");
            });
    }

    @Test
    void aFormKeyWithADotIsWrittenInBracketsAndTheDottedSpellingStopsTheStart() {
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true", "datum.webauthn.forms[my.form].mode=required").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(FormSigningSource.class).forForm("my.form").mode()).isEqualTo(FormSigning.Mode.REQUIRED);
        });
        // forms.my.form.mode is a form "my" with a member "form": the binder drops it and the form would sign nothing.
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true", "datum.webauthn.forms.my.form.mode=required")
            .run(context -> assertThat(failure(context)).contains("datum.webauthn"));
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true", "datum.webauthn.modee=required")
            .run(context -> assertThat(failure(context)).as("a mistyped member").contains("modee"));
    }

    // ------------------------------------------------------------------------------------------ the seam

    @Test
    void theReceiversSignatureCheckIsWiredAndIsReplaceable() {
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true").run(context ->
            assertThat(context.getBean(SubmissionSignatureCheck.class)).isInstanceOf(PublishingSignatureCheck.class));
        SubmissionSignatureCheck own = new SubmissionSignatureCheck() {
            @Override
            public com.argusvane.datum.submissions.spi.SignatureVerdict check(
                com.argusvane.datum.submissions.spi.CandidateSubmission submission) {
                return com.argusvane.datum.submissions.spi.SignatureVerdict.absent();
            }
        };
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true").withBean(SubmissionSignatureCheck.class, () -> own)
            .run(context -> assertThat(context.getBean(SubmissionSignatureCheck.class)).isSameAs(own));
    }

    @Test
    void theSubmissionsThrottleCountsPasskeyRequestsUnderKindRegister() {
        List<Object> seen = new java.util.ArrayList<>();
        SubmissionThrottle throttle = new SubmissionThrottle() {
            @Override
            public ThrottleDecision check(com.argusvane.datum.submissions.spi.ThrottleKey key) {
                seen.add("check:" + key.kind());
                return seen.size() > 2 ? new ThrottleDecision.Deny(Duration.ofSeconds(30)) : ThrottleDecision.ALLOW;
            }

            @Override
            public void record(com.argusvane.datum.submissions.spi.ThrottleKey key) {
                seen.add("record:" + key.kind());
            }
        };
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true").withBean(SubmissionThrottle.class, () -> throttle).run(context -> {
            PasskeyThrottle passkeyThrottle = context.getBean(PasskeyThrottle.class);
            assertThat(passkeyThrottle).isInstanceOf(SubmissionsPasskeyThrottle.class);
            assertThat(passkeyThrottle.check("1.2.3.4", "petition", null)).as("allowed: counted").isSameAs(PasskeyThrottle.Decision.ALLOW);
            assertThat(seen).containsExactly("check:REGISTER", "record:REGISTER");
            assertThat(passkeyThrottle.check("1.2.3.4", "petition", null)).as("denied: told when to come back").isEqualTo(new PasskeyThrottle.Decision.Deny(Duration.ofSeconds(30)));
        });
    }

    @Test
    void theSubmissionsThrottleCountsPasskeyRequestsUnderItsAddressLimit() {
        List<String> counted = new java.util.ArrayList<>();
        SubmissionThrottle throttle = new SubmissionThrottle() {
            @Override
            public ThrottleDecision check(com.argusvane.datum.submissions.spi.ThrottleKey key) {
                return ThrottleDecision.ALLOW;
            }

            @Override
            public void record(com.argusvane.datum.submissions.spi.ThrottleKey key) {
            }

            @Override
            public ThrottleDecision checkAddress(String address) {
                return counted.size() >= 2 ? new ThrottleDecision.Deny(Duration.ofSeconds(20)) : ThrottleDecision.ALLOW;
            }

            @Override
            public void recordAddress(String address) {
                counted.add(address);
            }
        };
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true").withBean(SubmissionThrottle.class, () -> throttle).run(context -> {
            PasskeyThrottle passkeyThrottle = context.getBean(PasskeyThrottle.class);
            assertThat(passkeyThrottle.checkAddress("2001:db8:1:2::/64")).isSameAs(PasskeyThrottle.Decision.ALLOW);
            assertThat(passkeyThrottle.checkAddress("1.2.3.4")).isSameAs(PasskeyThrottle.Decision.ALLOW);
            assertThat(passkeyThrottle.checkAddress("1.2.3.4")).isEqualTo(new PasskeyThrottle.Decision.Deny(Duration.ofSeconds(20)));
            assertThat(counted).containsExactly("2001:db8:1:2::/64", "1.2.3.4");
        });
    }

    @Test
    void withoutASubmissionsThrottleNothingIsLimited() {
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true").run(context ->
            assertThat(context.getBean(PasskeyThrottle.class).check("1.2.3.4", null, null)).isSameAs(PasskeyThrottle.Decision.ALLOW));
    }

    // ------------------------------------------------------------------------------------------ who is asking

    @Test
    void springSecurityPrincipalsAreTheOwners() {
        enabled().withPropertyValues("datum.webauthn.allow-memory-stores=true").run(context -> {
            PasskeySubjectResolver subjects = context.getBean(PasskeySubjectResolver.class);
            assertThat(subjects).isInstanceOf(SecurityPrincipalSubjectResolver.class);

            assertThat(subjects.resolve(null).isAnonymous()).isTrue();
            assertThat(subjects.resolve(new AnonymousAuthenticationToken("key", "anonymousUser", AuthorityUtils.createAuthorityList("ROLE_ANONYMOUS")))
                .isAnonymous()).as("Spring Security's anonymous token is a visitor").isTrue();
            assertThat(subjects.resolve(new UsernamePasswordAuthenticationToken("ada", "pw")).isAnonymous()).as("not yet authenticated").isTrue();
            PasskeySubject ada = subjects.resolve(UsernamePasswordAuthenticationToken.authenticated("ada", "pw", AuthorityUtils.createAuthorityList("ROLE_USER")));
            assertThat(ada).isEqualTo(new PasskeySubject("ada", "ada", "ada"));
            assertThat(subjects.resolve(() -> "container-user").uid()).isEqualTo("container-user");
            assertThat(subjects.resolve(() -> "").isAnonymous()).isTrue();
        });
    }
}
