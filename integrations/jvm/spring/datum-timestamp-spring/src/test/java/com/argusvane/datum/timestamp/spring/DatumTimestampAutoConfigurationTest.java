package com.argusvane.datum.timestamp.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.timestamp.InMemoryTsaLog;
import com.argusvane.datum.timestamp.TimestampAuthority;
import com.argusvane.datum.timestamp.TsaClientStore;
import com.argusvane.datum.timestamp.TsaLog;
import com.argusvane.datum.timestamp.TsaSerialAllocator;
import com.argusvane.datum.timestamp.web.PropertiesTsaClientStore;
import com.argusvane.datum.timestamp.web.TsaEndpoint;
import com.argusvane.datum.timestamp.web.TsaHealth;
import com.argusvane.datum.web.monitoring.DatumHealthContributors;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/** The default beans, what replaces them, the signer's sources and the settings that stop the start. */
class DatumTimestampAutoConfigurationTest {

    @TempDir
    Path dir;

    /** No acknowledgement: what a host that set nothing about memory stores gets. */
    private ApplicationContextRunner bare() {
        return new ApplicationContextRunner().withConfiguration(AutoConfigurations.of(DatumTimestampAutoConfiguration.class));
    }

    /** The runner of the tests that have no DataSource: they acknowledge the in-memory serials. */
    private ApplicationContextRunner runner() {
        return bare().withPropertyValues("datum.tsa.allow-memory-stores=true");
    }

    /** Two {@link com.argusvane.datum.timestamp.TimestampRequestCustomizer} beans against their {@code @Order}. */
    @org.springframework.context.annotation.Configuration(proxyBeanMethods = false)
    static class CustomizerBeans {

        static final java.util.List<String> CALLS = java.util.Collections.synchronizedList(new java.util.ArrayList<>());

        @org.springframework.context.annotation.Bean
        @org.springframework.core.annotation.Order(2)
        com.argusvane.datum.timestamp.TimestampRequestCustomizer refusesSecond() {
            return draft -> {
                CALLS.add("second:" + draft.client());
                if ("blocked".equals(draft.client())) {
                    throw com.argusvane.datum.core.hooks.HookRefusedException.forbidden("tsa.client.blocked", "This client may not ask.");
                }
            };
        }

        @org.springframework.context.annotation.Bean
        @org.springframework.core.annotation.Order(1)
        com.argusvane.datum.timestamp.TimestampRequestCustomizer recordsFirst() {
            return draft -> CALLS.add("first:" + draft.client());
        }
    }

    @Test
    void theApplicationsRequestCustomizersRunInTheirOrderBeforeEveryToken() {
        CustomizerBeans.CALLS.clear();
        runner().withUserConfiguration(CustomizerBeans.class)
            .withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true", "datum.tsa.access=open").run(context -> {
                assertThat(context).hasNotFailed();
                com.argusvane.datum.timestamp.TimestampAuthority authority = context.getBean(com.argusvane.datum.timestamp.TimestampAuthority.class);
                byte[] query = com.argusvane.datum.timestamp.TimestampQuery.forData("x".getBytes(java.nio.charset.StandardCharsets.UTF_8));
                assertThat(authority.respond(query, "client-1").granted()).isTrue();
                com.argusvane.datum.timestamp.TimestampReply refused = authority.respond(query, "blocked");
                assertThat(refused.status()).isEqualTo(400);
                assertThat(refused.refusal().failInfo()).isEqualTo(com.argusvane.datum.timestamp.TimestampRefusal.FAIL_BAD_REQUEST);
                assertThat(CustomizerBeans.CALLS).containsExactly("first:client-1", "second:client-1", "first:blocked", "second:blocked");
            });
    }

    @Test
    void nothingIsMadeUnlessTheServerIsEnabled() {
        runner().run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).doesNotHaveBean(TsaEndpoint.class).doesNotHaveBean(TimestampAuthority.class);
        });
        runner().withPropertyValues("datum.tsa.enabled=true", "datum.enabled=false").run(context -> assertThat(context).doesNotHaveBean(TsaEndpoint.class));
    }

    @Test
    void aMaxRequestSizeOutsideOneByteToOneMegabyteStopsTheStart() {
        for (String size : new String[] {"0B", "2MB", "1GB"}) {
            runner().withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true", "datum.tsa.max-request-size=" + size)
                .run(context -> assertThat(context).as(size).hasFailed());
        }
        runner().withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true", "datum.tsa.max-request-size=1MB")
            .run(context -> assertThat(context).hasNotFailed());
    }

    /** A bad flood limit or window would weaken the rate limit silently (limit 0 is off), so each stops the start naming its property. */
    @Test
    void aBadFloodLimitOrWindowStopsTheStartNamingTheProperty() {
        for (String[] row : new String[][] {{"datum.tsa.flood.limit=-1", "datum.tsa.flood.limit"}, {"datum.tsa.flood.window=0s", "datum.tsa.flood.window"},
            {"datum.tsa.flood.window=500ms", "datum.tsa.flood.window"}}) {
            runner().withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true", row[0])
                .run(context -> assertThat(rootMessages(context.getStartupFailure())).as(row[0]).contains(row[1]));
        }
        runner().withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true", "datum.tsa.flood.limit=0", "datum.tsa.flood.window=1s")
            .run(context -> assertThat(context).hasNotFailed());
    }

    @Test
    void withoutJdbcSerialsAreInMemoryAndHealthSaysSo() {
        runner().withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true", "datum.tsa.access=open").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(TsaSerialAllocator.class)).isInstanceOf(InMemoryTsaLog.class);
            assertThat(context.getBean(TsaLog.class)).isInstanceOf(InMemoryTsaLog.class);
            assertThat(context.getBean(TsaClientStore.class)).isInstanceOf(PropertiesTsaClientStore.class);
            assertThat(context.getBean(TsaHealth.class).status().details()).containsEntry("serialAllocator", "memory")
                .containsEntry("serials", "memory (acknowledged)");
            assertThat(context.getBean(TsaHealth.class).status().up()).isTrue();
        });
    }

    @Test
    void aDataSourceBeanSwitchesTheSerialsAndTheLogToTheDatabase() {
        bare().withBean(DataSource.class, () -> Migrations.database("h2").getDataSource())
            .withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true", "datum.tsa.access=open").run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(TsaSerialAllocator.class)).isInstanceOf(JdbcTsaSerialAllocator.class);
                assertThat(context.getBean(TsaLog.class)).isInstanceOf(JdbcTsaLog.class);
                assertThat(context.getBean(TsaClientStore.class)).as("clients stay in configuration unless asked").isInstanceOf(PropertiesTsaClientStore.class);
                assertThat(context.getBean(TsaHealth.class).status().details()).containsEntry("serialAllocator", "jdbc").containsEntry("serials", "jdbc");
                TimestampAuthority authority = context.getBean(TimestampAuthority.class);
                assertThat(authority.stamp("x".getBytes(), "sealing")).isNotEmpty();
                assertThat(context.getBean(TsaLog.class).count()).isEqualTo(1);
            });
    }

    /** The application's transaction manager over the one DataSource is the one the stores' calls run under. */
    @Test
    void theStoresRunUnderTheApplicationsTransactionManagerForTheirDataSource() {
        DataSource source = Migrations.database("h2").getDataSource();
        org.springframework.transaction.PlatformTransactionManager application = new org.springframework.jdbc.datasource.DataSourceTransactionManager(source);
        bare().withBean(DataSource.class, () -> source).withBean(org.springframework.transaction.PlatformTransactionManager.class, () -> application)
            .withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true", "datum.tsa.client-store=jdbc").run(context -> {
                assertThat(context).hasNotFailed();
                for (Object store : java.util.List.of(context.getBean(JdbcTsaSerialAllocator.class), context.getBean(JdbcTsaLog.class),
                    context.getBean(JdbcTsaClientStore.class))) {
                    com.argusvane.datum.springweb.spring.DatumStoreJdbc jdbc = (com.argusvane.datum.springweb.spring.DatumStoreJdbc)
                        org.springframework.test.util.ReflectionTestUtils.getField(store, "jdbc");
                    assertThat(jdbc.transactionManager()).isSameAs(application);
                    assertThat(jdbc.dataSource()).isSameAs(source);
                }
            });
    }

    @Test
    void theClientStoreCanBeTheDatabase() {
        bare().withBean(DataSource.class, () -> Migrations.database("h2").getDataSource())
            .withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true", "datum.tsa.client-store=jdbc").run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(TsaClientStore.class)).isInstanceOf(JdbcTsaClientStore.class);
                // Made after Flyway, Liquibase or spring.sql.init.
                for (String store : java.util.List.of("datumJdbcTsaSerialAllocator", "datumJdbcTsaLog", "datumJdbcTsaClientStore")) {
                    assertThat(context.getBeanFactory().findAnnotationOnBean(store, org.springframework.boot.sql.init.dependency.DependsOnDatabaseInitialization.class)).as(store).isNotNull();
                }
            });
    }

    @Test
    void withoutADataSourceTheInMemorySerialsAreRefusedUnlessAcknowledged() {
        bare().withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true").run(context -> {
            assertThat(context).hasFailed();
            String messages = rootMessages(context.getStartupFailure());
            assertThat(messages).contains("datum.tsa has no SQL store for its serial allocator (datum_tsa_log)")
                .contains("datum.tsa.allow-memory-stores=true").contains("V300__datum_timestamp.sql");
        });
        bare().withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true", "datum.tsa.allow-memory-stores=false")
            .run(context -> assertThat(context).hasFailed());
    }

    @Test
    void acknowledgedInMemorySerialsStartAndTheStartupCheckStillWarns() {
        bare().withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true", "datum.tsa.allow-memory-stores=true").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(TsaSerialAllocator.class)).isInstanceOf(InMemoryTsaLog.class);
            assertThat(context.getBeansOfType(com.argusvane.datum.core.DatumStartupCheck.class).values())
                .anySatisfy(check -> assertThat(check.check()).anySatisfy(notice -> assertThat(notice.message()).contains("serial numbers from memory")));
        });
    }

    @Test
    void anApplicationAllocatorNeedsNoAcknowledgement() {
        TsaSerialAllocator mine = entry -> 7;
        bare().withBean(TsaSerialAllocator.class, () -> mine).withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true")
            .run(context -> assertThat(context).hasNotFailed());
    }

    @Test
    void twoDataSourcesLeaveTheSerialsInMemoryRatherThanStopTheStart() {
        runner().withBean("one", DataSource.class, () -> Migrations.database("h2").getDataSource()).withBean("two", DataSource.class, () -> Migrations.database("h2").getDataSource())
            .withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true").run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(TsaSerialAllocator.class)).isInstanceOf(InMemoryTsaLog.class);
            });
    }

    @Test
    void anApplicationAllocatorReplacesOursAndHealthCallsItCustom() {
        TsaSerialAllocator mine = entry -> 41;
        runner().withBean(TsaSerialAllocator.class, () -> mine).withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(TsaSerialAllocator.class)).isSameAs(mine);
            assertThat(context).doesNotHaveBean(InMemoryTsaLog.class);
            assertThat(context.getBean(TsaHealth.class).status().details()).containsEntry("serialAllocator", "custom");
        });
    }

    @Test
    void theHealthCheckAndCapabilityRegisterWithTheWebModule() {
        runner().withUserConfiguration(MonitoringRegistries.class)
            .withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true").run(context -> {
                assertThat(context.getBean(DatumHealthContributors.class).evaluate()).containsKey("datum-tsa");
                assertThat(context.getBean(com.argusvane.datum.web.monitoring.DatumCapabilities.class).present()).contains("timestamp");
            });
    }

    @Test
    void aPolicyThatIsNoObjectIdentifierStopsTheStart() {
        runner().withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true", "datum.tsa.policy=not-an-oid")
            .run(context -> assertThat(context).hasFailed());
    }

    @Test
    void anUnreadableRetiredCertificateStopsTheStart() throws IOException {
        Path junk = Files.writeString(dir.resolve("junk.pem"), "no certificate here");
        runner().withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true", "datum.tsa.retired-certificates=" + junk)
            .run(context -> assertThat(context).hasFailed());
    }

    @Test
    void thePropertiesHaveTheDocumentedDefaults() {
        runner().withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true").run(context -> {
            DatumTsaProperties p = context.getBean(DatumTsaProperties.class);
            assertThat(p.getPath()).isEqualTo("/tsa");
            assertThat(p.getAccess()).isEqualTo(com.argusvane.datum.timestamp.web.TsaSettings.Access.CLIENTS);
            assertThat(p.getAccuracy()).isEqualTo(java.time.Duration.ofSeconds(1));
            assertThat(p.getMaxRequestSize().toBytes()).isEqualTo(16 * 1024);
            assertThat(p.getFlood().getLimit()).isEqualTo(1000);
            assertThat(p.getFlood().getWindow()).isEqualTo(java.time.Duration.ofHours(1));
            assertThat(p.getClientStore()).isEqualTo(com.argusvane.datum.timestamp.web.TsaSettings.ClientStore.PROPERTIES);
            assertThat(context.getBean(TimestampAuthority.class).policy()).isEqualTo(TimestampAuthority.DEFAULT_POLICY);
        });
    }

    private static String rootMessages(Throwable failure) {
        StringBuilder out = new StringBuilder();
        for (Throwable t = failure; t != null; t = t.getCause()) {
            out.append(t.getMessage()).append('\n');
        }
        return out.toString();
    }

    /** The literal defaults (kept for the configuration metadata) are the library's, and the cap is checked there. */
    @Test
    void thePropertiesDefaultsAreTheSettingsDefaults() {
        assertThat(new DatumTsaProperties().toSettings()).isEqualTo(com.argusvane.datum.timestamp.web.TsaSettings.defaults());
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new com.argusvane.datum.timestamp.web.TsaSettings(true, "/", null, null,
                java.time.Duration.ZERO, 2L << 20, 0, java.time.Duration.ofHours(1), null, null, null, null, null, false, null, 10))
            .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("datum.tsa.max-request-size");
        assertThat(com.argusvane.datum.timestamp.web.TsaSettings.normalise("x/")).isEqualTo("/x");
        assertThat(com.argusvane.datum.timestamp.web.TsaSettings.normalise("/")).isEqualTo("/tsa");
    }

    // ------------------------------------------------------------------------------------------ routes base

    /**
     * The base the security matchers follow is the one the routes are mapped under, from the TsaSettings bean, so an
     * application's own settings bean with another path moves the matchers too (the property does not decide).
     */
    @Test
    void theRouteBaseForTheSecurityMatchersIsTheSettingsBeans() {
        DatumTsaProperties mine = new DatumTsaProperties();
        mine.setPath("/stamps");
        mine.setAllowMemoryStores(true);
        mine.getSigner().setSelfSigned(true);
        com.argusvane.datum.timestamp.web.TsaSettings settings = mine.toSettings();
        runner().withBean(com.argusvane.datum.timestamp.web.TsaSettings.class, () -> settings)
            .withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true", "datum.tsa.path=/property-tsa").run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(com.argusvane.datum.timestamp.web.TsaRoutes.class).path()).isEqualTo("/stamps");
                assertThat(context.getBean(com.argusvane.datum.springweb.spring.DatumRouteBase.class)).isEqualTo(
                    new com.argusvane.datum.springweb.spring.DatumRouteBase(com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base.TSA,
                        "/stamps"));
            });
        // The security WARN's access is the settings bean's too: open in the bean, clients in the property.
        mine.setAccess(com.argusvane.datum.timestamp.web.TsaSettings.Access.OPEN);
        com.argusvane.datum.timestamp.web.TsaSettings open = mine.toSettings();
        runner().withBean(com.argusvane.datum.timestamp.web.TsaSettings.class, () -> open)
            .withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true", "datum.tsa.access=clients").run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(com.argusvane.datum.springweb.spring.DatumRouteBase.class)).isEqualTo(
                    new com.argusvane.datum.springweb.spring.DatumRouteBase(com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base.TSA,
                        "/stamps", true));
            });
    }

    private static int admitted(org.springframework.context.ApplicationContext context, String cookie) {
        com.argusvane.datum.timestamp.web.TsaEndpoint.Admission admission = context.getBean(TsaEndpoint.class).admit(
            new com.argusvane.datum.timestamp.web.TsaRequest("application/timestamp-query", null, java.util.List.of(cookie), "192.0.2.1", 10));
        return admission.admitted() ? 200 : admission.refusal().status();
    }

    /**
     * A renamed session cookie is refused on either stack: {@code server.servlet.session.cookie.name} and the WebFlux
     * {@code server.reactive.session.cookie.name} both join a configured list of names (beside the default {@code *} they
     * are redundant, since any cookie is refused).
     */
    @Test
    void aSessionCookieRenamedOnEitherStackIsStillRefused() {
        runner().withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true", "datum.tsa.access=open",
            "datum.tsa.session-cookies=JSESSIONID,SESSION",
            "server.servlet.session.cookie.name=MVCSESSION", "server.reactive.session.cookie.name=FLUXSESSION").run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(admitted(context, "FLUXSESSION")).as("the WebFlux session cookie").isEqualTo(403);
                assertThat(admitted(context, "MVCSESSION")).as("the servlet session cookie").isEqualTo(403);
                assertThat(admitted(context, "JSESSIONID")).as("the configured names stay").isEqualTo(403);
                assertThat(admitted(context, "SESSION")).isEqualTo(403);
                assertThat(admitted(context, "theme")).as("any other cookie passes").isEqualTo(200);
            });
        runner().withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true", "datum.tsa.access=open",
            "datum.tsa.session-cookies=JSESSIONID", "server.reactive.session.cookie.name= ")
            .run(context -> assertThat(admitted(context, "theme")).as("a blank name adds none").isEqualTo(200));
    }

    /** The default is {@code *}: any cookie is refused, the host's renamed one included; no cookie passes. */
    @Test
    void theDefaultRefusesAnyCookie() {
        runner().withPropertyValues("datum.tsa.enabled=true", "datum.tsa.signer.self-signed=true", "datum.tsa.access=open",
            "server.servlet.session.cookie.name=MVCSESSION").run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(com.argusvane.datum.timestamp.web.TsaSettings.class).sessionCookies()).containsExactly("*");
                assertThat(admitted(context, "a")).as("an arbitrary cookie").isEqualTo(403);
                assertThat(admitted(context, "theme")).isEqualTo(403);
                assertThat(admitted(context, "MVCSESSION")).as("redundant beside the star, still refused").isEqualTo(403);
            });
    }
}
