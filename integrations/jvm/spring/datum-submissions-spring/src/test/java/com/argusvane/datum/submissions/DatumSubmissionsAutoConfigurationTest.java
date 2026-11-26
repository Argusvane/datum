package com.argusvane.datum.submissions;

import com.argusvane.datum.sandbox.runtime.TestRuntime;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.sandbox.runtime.EngineBytecodeException;
import com.argusvane.datum.sandbox.wasi.EngineSelectionException;
import com.argusvane.datum.sandbox.wasi.GuestRuntimeProvider;
import com.argusvane.datum.sandbox.protocol.HostOptions;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.protocol.Sandbox;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.spring.DatumFormsAutoConfiguration;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import com.argusvane.datum.sandbox.events.SandboxReadyEvent;
import com.argusvane.datum.submissions.receiver.LoggingSubmissionHandler;
import com.argusvane.datum.submissions.receiver.SubmissionReceiver;
import com.argusvane.datum.sandbox.runtime.DatumSandbox;
import com.argusvane.datum.sandbox.runtime.SandboxStatus;
import com.argusvane.datum.submissions.spi.SubmissionHandler;
import com.argusvane.datum.submissions.spi.SubmissionReceipt;
import com.argusvane.datum.submissions.spi.SubmissionRequest;
import com.argusvane.datum.sandbox.spring.DatumSandboxAutoConfiguration;
import com.argusvane.datum.submissions.spring.DatumSubmissionsAutoConfiguration;
import com.argusvane.datum.web.monitoring.DatumCapabilities;
import com.argusvane.datum.web.monitoring.DatumHealthContributors;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.FilteredClassLoader;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.event.EventListener;
import org.springframework.core.io.ClassPathResource;

/**
 * The auto-configuration over the packaged programs (datum-programs, sha-checked) and a test runtime: the
 * runtime starts and proves them, the receiver works end to end, the defaults back off, and a runtime that
 * cannot prove its programs stops the context unless fail-fast is off.
 */
class DatumSubmissionsAutoConfigurationTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumFormsAutoConfiguration.class,
            DatumSandboxAutoConfiguration.class, DatumSubmissionsAutoConfiguration.class))
        .withPropertyValues("datum.forms.locations=classpath:/datum-test-forms/*.json", "datum.runtime.warm-up-runs=1");

    @Configuration(proxyBeanMethods = false)
    static class WithRuntime {

        final List<Object> ready = new ArrayList<>();

        @Bean
        TestRuntime testRuntime() {
            return new TestRuntime();
        }

        @EventListener
        void on(SandboxReadyEvent event) {
            ready.add(event);
        }
    }

    /** An application's own runtime bean: built over the binding's program store, settings and engine. */
    @Configuration(proxyBeanMethods = false)
    static class OwnRuntime {

        @Bean
        TestRuntime testRuntime() {
            return new TestRuntime();
        }

        @Bean
        DatumSandbox applicationRuntime(TestRuntime engine, com.argusvane.datum.sandbox.runtime.ProgramStore store,
                                        ProgramLimits limits, HostOptions hostOptions,
                                        com.argusvane.datum.sandbox.runtime.SandboxSettings settings) {
            return DatumSandbox.builder().runtime(engine).store(store).limits(limits).hostOptions(hostOptions).settings(settings)
                .events(com.argusvane.datum.core.DatumEventPublisher.noop()).runLog(com.argusvane.datum.sandbox.protocol.RunLog.slf4j()).build();
        }
    }

    /**
     * The runtime health check and the submissions capability are beans of their own, built over whichever
     * {@link DatumSandbox} the context has, so an application runtime keeps {@code datum/runtime} and {@code info.datum}.
     */
    @Test
    void anApplicationsRuntimeKeepsTheRuntimeCheckAndTheCapability() {
        runner.withUserConfiguration(OwnRuntime.class).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBeansOfType(DatumSandbox.class)).containsOnlyKeys("applicationRuntime");
            // The lifecycle bean starts whichever runtime the context has.
            assertThat(context.getBean(DatumSandbox.class).status().state()).isEqualTo(SandboxStatus.State.UP);
            assertThat(context.getBean(DatumHealthContributors.class).evaluate()).containsKey("runtime");
            assertThat(context.getBean(DatumHealthContributors.class).evaluate("runtime").up()).isTrue();
            assertThat(context.getBean(DatumCapabilities.class).present()).contains("submissions");
            assertThat(context.getBean(DatumCapabilities.class).details()).containsKey("engineMode");
        });
    }

    @Test
    void theRuntimeStartsAndTheReceiverAcceptsASubmission() {
        runner.withUserConfiguration(WithRuntime.class).run(context -> {
            assertThat(context).hasNotFailed();
            DatumSandbox runtime = context.getBean(DatumSandbox.class);
            assertThat(runtime.status().state()).isEqualTo(SandboxStatus.State.UP);
            assertThat(runtime.status().sandboxAbi()).isEqualTo("4.1.0");
            assertThat(context.getBean(WithRuntime.class).ready).hasSize(1);
            assertThat(context).hasSingleBean(LoggingSubmissionHandler.class);
            assertThat(context.getBean(DatumHealthContributors.class).evaluate()).containsKey("runtime");
            assertThat(context.getBean(DatumCapabilities.class).present()).contains("submissions");
            assertThat(context.getBean(ProgramLimits.class).maxBodyBytes()).isEqualTo(1024 * 1024);
            assertThat(context.getBean(HostOptions.class).formulaErrors()).isEqualTo("fail");

            byte[] body = Fixtures.delivered(Fixtures.envelope("contact", "1", "{\"name\":\"Ada\"}"));
            var answer = context.getBean(SubmissionReceiver.class).submit(SubmissionRequest.json(), body);
            assertThat(answer.body().path("status").stringValue()).isEqualTo("accepted");
            assertThat(answer.body().path("id").stringValue()).hasSize(36);

            // The sandbox service follows the runtime, and datum-forms' definition service runs through it.
            ObjectProvider<Sandbox> sandbox = context.getBeanProvider(Sandbox.class);
            assertThat(sandbox.getIfAvailable()).isNotNull();
            assertThat(context.getBean(DefinitionService.class).currentPublic("contact").definition().path("id").stringValue()).isEqualTo("contact");
        });
    }

    @Test
    void anApplicationHandlerReplacesTheLoggingOne() {
        runner.withUserConfiguration(WithRuntime.class)
            .withBean(SubmissionHandler.class, () -> submission -> new SubmissionReceipt("mine", "R-1", null))
            .run(context -> {
                assertThat(context).doesNotHaveBean(LoggingSubmissionHandler.class);
                byte[] body = Fixtures.delivered(Fixtures.envelope("contact", "1", "{\"name\":\"Ada\"}"));
                assertThat(context.getBean(SubmissionReceiver.class).submit(SubmissionRequest.json(), body).body().path("id").stringValue())
                    .isEqualTo("mine");
            });
    }

    /**
     * The application's one HostContextProvider reaches every run; two are refused at start-up rather than one
     * picked silently, since the context decides which rules are judged.
     */
    @Test
    void oneHostContextProviderIsUsedAndTwoStopTheContext() {
        com.argusvane.datum.submissions.spi.HostContextProvider staff =
            request -> java.util.Optional.of(java.util.Map.of("role", "staff"));
        runner.withUserConfiguration(WithRuntime.class)
            .withBean("staffContext", com.argusvane.datum.submissions.spi.HostContextProvider.class, () -> staff)
            .run(context -> {
                assertThat(context).hasNotFailed();
                byte[] body = Fixtures.delivered(Fixtures.envelope("contact", "1", "{\"name\":\"Ada\"}"));
                assertThat(context.getBean(SubmissionReceiver.class).submit(SubmissionRequest.json(), body).body().path("status").stringValue())
                    .isEqualTo("accepted");
            });
        runner.withUserConfiguration(WithRuntime.class)
            .withBean("staffContext", com.argusvane.datum.submissions.spi.HostContextProvider.class, () -> staff)
            .withBean("otherContext", com.argusvane.datum.submissions.spi.HostContextProvider.class, () -> staff)
            .run(context -> assertThat(context).hasFailed());
    }

    @Test
    void aRuntimeThatCannotProveItsProgramsStopsTheContext() {
        runner.withBean(GuestRuntime.class, () -> {
            TestRuntime failing = new TestRuntime();
            failing.sandboxProbeFails = true;
            return failing;
        }).run(context -> {
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure()).hasMessageContaining("datumSandboxLifecycle").cause().hasMessageContaining("abi_mismatch");
        });
    }

    @Test
    void withoutFailFastTheContextStartsDownAndRunsAnswer503() {
        runner.withPropertyValues("datum.runtime.fail-fast=false").withBean(GuestRuntime.class, () -> {
            TestRuntime failing = new TestRuntime();
            failing.sandboxProbeFails = true;
            return failing;
        }).run(context -> {
            assertThat(context).hasNotFailed();
            DatumSandbox runtime = context.getBean(DatumSandbox.class);
            assertThat(runtime.status().state()).isEqualTo(SandboxStatus.State.DOWN);
            assertThat(context.getBean(DatumHealthContributors.class).evaluate().get("runtime").up()).isFalse();
            assertThat(context.getBeanProvider(Sandbox.class).getIfAvailable()).isNull();
            byte[] body = Fixtures.delivered(Fixtures.envelope("contact", "1", "{\"name\":\"Ada\"}"));
            org.assertj.core.api.Assertions.assertThatThrownBy(() -> context.getBean(SubmissionReceiver.class).submit(SubmissionRequest.json(), body))
                .isInstanceOf(ProgramUnavailableException.class);
        });
    }

    /** The services file an engine jar registers its provider in. */
    private static final ClassPathResource ENGINE_SERVICES = new ClassPathResource("META-INF/services/" + GuestRuntimeProvider.class.getName());

    @Test
    void withoutAnyRuntimeTheStartNamesTheMissingEngine() {
        // datum-sandbox-endive is on this module's test class path; hiding its services file stands for
        // an application without an engine jar.
        runner.withClassLoader(new FilteredClassLoader(ENGINE_SERVICES)).run(context -> {
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure()).rootCause().hasMessageContaining("datum-sandbox-endive")
                .hasMessageContaining("engines found: none");
        });
    }

    /** A misnamed engine stops the start, naming the one engine there is. */
    @Test
    void anUnknownEngineIdStopsTheStartNamingEndiveAsTheOnlyEngineFound() {
        runner.withPropertyValues("datum.runtime.engine=nope").run(context -> {
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure()).rootCause().isInstanceOf(EngineSelectionException.class)
                .hasMessageContaining("No engine has the id \"nope\"").hasMessageContaining("engines found: endive (available).");
        });
        // Not softened by fail-fast=false: a misnamed engine is a configuration error, not a program to prove later.
        runner.withPropertyValues("datum.runtime.engine=nope", "datum.runtime.fail-fast=false")
            .run(context -> assertThat(context).hasFailed());
    }

    /** The default id is endive, created through its provider (no class named anywhere), and health reports its info. */
    @Test
    void theDefaultEngineIsEndiveCreatedThroughItsProvider() {
        // The program cannot be read, so no guest runs (no runner jar here: it is bytecode, so the allowance is set); fail-fast
        // off keeps the context up with the runtime DOWN.
        runner.withPropertyValues("datum.runtime.allow-bytecode=true", "datum.runtime.fail-fast=false",
                "datum.runtime.programs.sandbox=file:/definitely/not/a/program.js")
            .run(context -> {
                assertThat(context).hasNotFailed();
                GuestRuntime engine = context.getBean(GuestRuntime.class);
                assertThat(engine.getClass().getName()).isEqualTo("com.argusvane.datum.sandbox.endive.EndiveGuestRuntime");
                DatumSandbox runtime = context.getBean(DatumSandbox.class);
                assertThat(runtime.engine()).isEqualTo("endive");
                assertThat(runtime.status().details()).containsEntry("engine", "endive").containsEntry("engineMode", "bytecode")
                    .containsEntry("pdfCapable", false).containsKey("engineRelease");
                assertThat(context.getBean(DatumCapabilities.class).details()).containsEntry("engine", "endive")
                    .containsEntry("engineMode", "bytecode");
            });
    }

    /**
     * The allowed path end to end with the real engine: Endive on bytecode (no runner jar here), the packaged sandbox
     * program, the proof and the warm-up run for real, and the runtime reaches UP, reports bytecode on health and keeps the
     * PDF program out. The runs are slow on bytecode, so one warm-up run is all this asks of it.
     */
    @Test
    void theRealEngineOnBytecodeWithTheAllowanceReachesUp() {
        runner.withPropertyValues("datum.runtime.allow-bytecode=true").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(GuestRuntime.class).getClass().getName())
                .isEqualTo("com.argusvane.datum.sandbox.endive.EndiveGuestRuntime");
            DatumSandbox runtime = context.getBean(DatumSandbox.class);
            assertThat(runtime.status().state()).as(runtime.status().reason()).isEqualTo(SandboxStatus.State.UP);
            assertThat(runtime.status().details()).containsEntry("engine", "endive").containsEntry("engineMode", "bytecode")
                .containsEntry("pdfCapable", false);
            assertThat(runtime.sandboxOrNull()).isNotNull();
            assertThat(context.getBean(DatumHealthContributors.class).evaluate("runtime").up()).isTrue();
        });
    }

    /**
     * The real engine on this module's class path has no runner jar, so it is Endive's bytecode fallback: by default the
     * context does not start, fail-fast or not, and the refusal names the property and the selector's reason.
     */
    @Test
    void theRealEngineOnBytecodeStopsTheStartUnlessAllowed() {
        for (String failFast : List.of("true", "false")) {
            runner.withPropertyValues("datum.runtime.fail-fast=" + failFast).run(context -> {
                assertThat(context).as("fail-fast " + failFast).hasFailed();
                assertThat(context.getStartupFailure()).rootCause().isInstanceOfSatisfying(EngineBytecodeException.class, refusal -> {
                    assertThat(refusal.property()).isEqualTo("datum.runtime.allow-bytecode");
                    assertThat(refusal.getMessage()).contains("The endive engine would run the programs as JVM bytecode")
                        .contains("datum.runtime.allow-bytecode is false")
                        // Endive's notes, which carry ProviderSelector's reason: here neither runner is on the class path ("no
                        // Redline runner is usable"), or on a platform without native code "the jar has no Redline native code".
                        .contains(refusal.engine().notes()).containsPattern("no Redline (runner is usable|native code)");
                    assertThat(refusal.action()).contains("datum.runtime.allow-bytecode=true");
                });
            });
        }
        // With the allowance the same engine starts: theDefaultEngineIsEndiveCreatedThroughItsProvider (no guest is run here).
    }

    @Test
    void theAllowanceBindsAndANativeEngineStartsWhateverItSays() {
        runner.withUserConfiguration(WithRuntime.class).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(com.argusvane.datum.sandbox.runtime.SandboxSettings.class).engine().allowBytecode()).isFalse();
            assertThat(context.getBean(DatumSandbox.class).status().state()).isEqualTo(SandboxStatus.State.UP);
        });
        for (String allowed : List.of("true", "false")) {
            runner.withUserConfiguration(WithRuntime.class).withPropertyValues("datum.runtime.allow-bytecode=" + allowed).run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(com.argusvane.datum.sandbox.runtime.SandboxSettings.class).engine().allowBytecode())
                    .isEqualTo(Boolean.parseBoolean(allowed));
                assertThat(context.getBean(DatumSandbox.class).status().state()).isEqualTo(SandboxStatus.State.UP);
            });
        }
        // Not a boolean: Spring's binding refuses it, naming the property.
        runner.withUserConfiguration(WithRuntime.class).withPropertyValues("datum.runtime.allow-bytecode=maybe").run(context -> {
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure()).hasStackTraceContaining("datum.runtime.allow-bytecode");
        });
    }

    /** An application's GuestRuntime wins (@ConditionalOnMissingBean); the engine id is then not read at all. */
    @Test
    void anApplicationsGuestRuntimeWinsAndTheEngineIdIsNotRead() {
        runner.withUserConfiguration(WithRuntime.class).withPropertyValues("datum.runtime.engine=nope").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(GuestRuntime.class)).isInstanceOf(TestRuntime.class);
            assertThat(context.getBean(DatumSandbox.class).engine()).isEqualTo(TestRuntime.class.getName());
        });
    }

    @Test
    void outOfRangeSettingsAreClampedAndTheSwitchTurnsTheModuleOff() {
        runner.withUserConfiguration(WithRuntime.class)
            .withPropertyValues("datum.runtime.validation.time-limit=600s", "datum.runtime.validation.memory=1KB",
                "datum.runtime.pdf.concurrency=0", "datum.web.api.max-body-size=1KB")
            .run(context -> {
                ProgramLimits limits = context.getBean(ProgramLimits.class);
                assertThat(limits.validationSeconds()).isEqualTo(60);
                assertThat(limits.validationMemory()).isEqualTo(4 * ProgramLimits.MIB);
                assertThat(limits.maxBodyBytes()).isEqualTo(16 * 1024);
                assertThat(context.getBean(DatumSandbox.class).pdfSlots().size()).isEqualTo(Math.min(2, ProgramLimits.cpus()));
            });
        runner.withUserConfiguration(WithRuntime.class).withPropertyValues("datum.enabled=false")
            .run(context -> assertThat(context).doesNotHaveBean(DatumSandbox.class).doesNotHaveBean(SubmissionReceiver.class));
    }

    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void hostWordsBindRelaxedAndAFractionOfASecondIsAClampedWithAWarning(CapturedOutput output) {
        runner.withUserConfiguration(WithRuntime.class)
            .withPropertyValues("datum.host.unknown-fields=Reject", "datum.host.log-level=DEBUG", "datum.host.formula-errors=warn",
                "datum.host.risky-patterns=allow", "datum.host.time-zone=America/Toronto", "datum.runtime.validation.time-limit=2500ms")
            .run(context -> {
                assertThat(context).hasNotFailed();
                HostOptions options = context.getBean(HostOptions.class);
                assertThat(options.formulaErrors()).isEqualTo("warn");
                assertThat(options.riskyPatterns()).isEqualTo("allow");
                assertThat(options.zone().getId()).isEqualTo("America/Toronto");
                assertThat(context.getBean(ProgramLimits.class).validationSeconds()).isEqualTo(2);

                byte[] body = Fixtures.delivered(Fixtures.envelope("contact", "1", "{\"name\":\"Ada\"}"));
                context.getBean(SubmissionReceiver.class).submit(SubmissionRequest.json(), body);
                var sent = context.getBean(TestRuntime.class).contexts().get(0);
                assertThat(sent.path("unknownFields").stringValue()).isEqualTo("reject");
                assertThat(sent.path("logLevel").stringValue()).isEqualTo("debug");
            });
        // The documented safety clamp keeps its WARN: whole seconds are what the program budgets take.
        assertThat(output).contains("datum.runtime.validation.time-limit = PT2.5S is not whole seconds");
    }

    @Test
    void aBadValueStopsTheContextNamingTheProperty() {
        // A mistyped switch fails the start as any Spring Boot enum does, rather than being clamped with a WARN.
        for (String[] bad : new String[][] {
            {"datum.host.formula-errors=warning", "datum.host.formula-errors"},
            {"datum.host.risky-patterns=maybe", "datum.host.risky-patterns"},
            {"datum.host.unknown-fields=drop", "datum.host.unknown-fields"},
            {"datum.host.log-level=loud", "datum.host.log-level"},
            {"datum.host.time-zone=Mars/Olympus", "datum.host.time-zone"},
            {"datum.web.throttle.by=ip,ssn", "datum.web.throttle.by"},
            {"datum.web.throttle.limit=0", "datum.web.throttle.limit"},
            {"datum.web.throttle.window=0s", "datum.web.throttle.window"}}) {
            runner.withUserConfiguration(WithRuntime.class).withPropertyValues(bad[0]).run(context -> {
                assertThat(context).as(bad[0]).hasFailed();
                assertThat(context.getStartupFailure()).as(bad[0]).hasStackTraceContaining(bad[1]);
            });
        }
    }

    /** The library documents an empty zone as the JVM's, and a container template that sets it empty must still start. */
    @Test
    void anEmptyTimeZoneIsTheJvmsZone() {
        for (String empty : new String[] {"datum.host.time-zone=", "datum.host.time-zone= "}) {
            runner.withUserConfiguration(WithRuntime.class).withPropertyValues(empty).run(context -> assertThat(context).as(empty).hasNotFailed());
        }
    }

    @Test
    void theReceiverSnapshotsEveryVersionItAccepts() {
        runner.withUserConfiguration(WithRuntime.class).run(context -> {
            byte[] body = Fixtures.delivered(Fixtures.envelope("contact", "1", "{\"name\":\"Ada\"}"));
            context.getBean(SubmissionReceiver.class).submit(SubmissionRequest.json(), body);
            // Read from the repository, which records nothing: only the receiver's path snapshots.
            String sha256 = context.getBean(com.argusvane.datum.forms.FormDefinitionRepository.class).current("contact").sha256();
            assertThat(context.getBean(com.argusvane.datum.forms.snapshot.DefinitionSnapshotStore.class).find("contact", sha256)).isPresent();
        });
    }

    @Test
    void configurationMetadataIsGenerated() throws Exception {
        try (InputStream in = getClass().getClassLoader().getResourceAsStream("META-INF/spring-configuration-metadata.json")) {
            assertThat(in).isNotNull();
            String metadata = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            // datum.runtime.* and datum.host.* are datum-sandbox-spring's metadata; this binding's own is datum.submissions.*.
            assertThat(metadata).contains("datum.submissions.idempotency").doesNotContain("datum.runtime.fail-fast");
        }
    }

    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void withoutJdbcTheIdempotencyStoreIsTheBoundedInMemoryOneAndTheDetailSaysSo(CapturedOutput output) {
        runner.withUserConfiguration(WithRuntime.class).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(com.argusvane.datum.submissions.spi.SubmissionIdempotencyStore.class))
                .isInstanceOf(com.argusvane.datum.submissions.idempotency.InMemorySubmissionIdempotencyStore.class);
            assertThat(context.getBean(DatumCapabilities.class).details()).containsEntry("idempotency", "memory");
            byte[] body = Fixtures.delivered(Fixtures.envelope("contact", "1", "{\"name\":\"Ada\"}"));
            SubmissionReceiver receiver = context.getBean(SubmissionReceiver.class);
            var first = receiver.submit(SubmissionRequest.json(), body);
            var second = receiver.submit(SubmissionRequest.json(), body);
            assertThat(first.body().path("handled").booleanValue()).isFalse();
            assertThat(second.body().path("handled").booleanValue()).isTrue();
            assertThat(second.body().path("id").stringValue()).isEqualTo(first.body().path("id").stringValue());
        });
        assertThat(output).contains("remembered in memory").contains("datum_submission_digest");
    }

    @Test
    void aDataSourceBeanSelectsTheJdbcStoreAndAnApplicationStoreReplacesBoth() {
        org.springframework.jdbc.core.JdbcTemplate jdbc = new org.springframework.jdbc.core.JdbcTemplate(
            new org.springframework.jdbc.datasource.DriverManagerDataSource("jdbc:h2:mem:idem-auto;DB_CLOSE_DELAY=-1", "sa", ""));
        jdbc.execute("CREATE TABLE IF NOT EXISTS datum_submission_digest (form_key VARCHAR(128) NOT NULL, version VARCHAR(255) NOT NULL, "
            + "digest CHAR(64) NOT NULL, receipt_id VARCHAR(255) NOT NULL, reference VARCHAR(255), receipt CLOB, created BIGINT NOT NULL, "
            + "PRIMARY KEY (form_key, version, digest))");
        runner.withUserConfiguration(WithRuntime.class).withBean(javax.sql.DataSource.class, jdbc::getDataSource).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(com.argusvane.datum.submissions.spi.SubmissionIdempotencyStore.class))
                .isInstanceOf(com.argusvane.datum.submissions.spring.JdbcSubmissionIdempotencyStore.class);
            assertThat(context.getBean(DatumCapabilities.class).details()).containsEntry("idempotency", "jdbc");
            // Made after Flyway, Liquibase or spring.sql.init, so the start-up probe sees the migrated table.
            assertThat(context.getBeanFactory().findAnnotationOnBean("datumJdbcSubmissionIdempotencyStore", org.springframework.boot.sql.init.dependency.DependsOnDatabaseInitialization.class)).isNotNull();
        });
        runner.withUserConfiguration(WithRuntime.class)
            .withBean(javax.sql.DataSource.class, jdbc::getDataSource)
            .withBean(com.argusvane.datum.submissions.spi.SubmissionIdempotencyStore.class, () -> new com.argusvane.datum.submissions.spi.SubmissionIdempotencyStore() {
                public java.util.Optional<Remembered> find(String formKey, String version, String submissionKey) {
                    return java.util.Optional.empty();
                }

                public void remember(String formKey, String version, String submissionKey, String digest, SubmissionReceipt receipt) {
                }
            }).run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(DatumCapabilities.class).details()).containsEntry("idempotency", "custom");
            });
    }

    /** The application's transaction manager over the one DataSource is the one the store's calls run under; another database's is not. */
    @Test
    void theStoreRunsUnderTheApplicationsTransactionManagerOnlyForItsDataSource() {
        org.springframework.jdbc.core.JdbcTemplate jdbc = new org.springframework.jdbc.core.JdbcTemplate(
            new org.springframework.jdbc.datasource.DriverManagerDataSource("jdbc:h2:mem:idem-tm;DB_CLOSE_DELAY=-1", "sa", ""));
        jdbc.execute("CREATE TABLE IF NOT EXISTS datum_submission_digest (form_key VARCHAR(128) NOT NULL, version VARCHAR(255) NOT NULL, "
            + "digest CHAR(64) NOT NULL, receipt_id VARCHAR(255) NOT NULL, reference VARCHAR(255), receipt CLOB, created BIGINT NOT NULL, "
            + "PRIMARY KEY (form_key, version, digest))");
        javax.sql.DataSource source = jdbc.getDataSource();
        org.springframework.transaction.PlatformTransactionManager mine = new org.springframework.jdbc.datasource.DataSourceTransactionManager(source);
        org.springframework.transaction.PlatformTransactionManager other = new org.springframework.jdbc.datasource.DataSourceTransactionManager(
            new org.springframework.jdbc.datasource.DriverManagerDataSource("jdbc:h2:mem:idem-other;DB_CLOSE_DELAY=-1", "sa", ""));
        for (org.springframework.transaction.PlatformTransactionManager application : java.util.List.of(mine, other)) {
            runner.withUserConfiguration(WithRuntime.class).withBean(javax.sql.DataSource.class, () -> source)
                .withBean(org.springframework.transaction.PlatformTransactionManager.class, () -> application).run(context -> {
                    assertThat(context).hasNotFailed();
                    com.argusvane.datum.springweb.spring.DatumStoreJdbc store = (com.argusvane.datum.springweb.spring.DatumStoreJdbc)
                        org.springframework.test.util.ReflectionTestUtils.getField(
                            context.getBean(com.argusvane.datum.submissions.spring.JdbcSubmissionIdempotencyStore.class), "jdbc");
                    assertThat(store.dataSource()).isSameAs(source);
                    if (application == mine) {
                        assertThat(store.transactionManager()).isSameAs(mine);
                    } else {
                        assertThat(store.transactionManager()).isNotSameAs(other);
                        assertThat(store.ownTransactions()).isTrue();
                    }
                });
        }
    }

    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void aDataSourceBeanWithoutTheTableFallsBackToMemoryWithAWarning(CapturedOutput output) {
        org.springframework.jdbc.core.JdbcTemplate jdbc = new org.springframework.jdbc.core.JdbcTemplate(
            new org.springframework.jdbc.datasource.DriverManagerDataSource("jdbc:h2:mem:idem-missing;DB_CLOSE_DELAY=-1", "sa", ""));
        runner.withUserConfiguration(WithRuntime.class).withBean(javax.sql.DataSource.class, jdbc::getDataSource).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(com.argusvane.datum.submissions.spi.SubmissionIdempotencyStore.class))
                .isInstanceOf(com.argusvane.datum.submissions.idempotency.InMemorySubmissionIdempotencyStore.class);
            assertThat(context.getBean(DatumCapabilities.class).details()).containsEntry("idempotency", "memory");
        });
        assertThat(output).contains("cannot be read").contains("V200__datum_submissions.sql");
    }

    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void theStartupBudgetPropertyIsReadAndClamped(CapturedOutput output) {
        runner.withUserConfiguration(WithRuntime.class).withPropertyValues("datum.runtime.startup-budget=2h").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(com.argusvane.datum.sandbox.spring.DatumSandboxProperties.class).getStartupBudget())
                .isEqualTo(java.time.Duration.ofHours(2));
            assertThat(context.getBean(WithRuntime.class)).isNotNull();
        });
        assertThat(output).contains("datum.runtime.startup-budget").contains("using 300 s");
        assertThat(com.argusvane.datum.sandbox.runtime.SandboxSettings.clampStartupBudget(null)).isEqualTo(java.time.Duration.ofSeconds(30));
        assertThat(com.argusvane.datum.sandbox.runtime.SandboxSettings.clampStartupBudget(java.time.Duration.ofSeconds(45)))
            .isEqualTo(java.time.Duration.ofSeconds(45));
    }

    /** The settings bean backs off for an application's own, and the limits, the host options and the service read it. */
    @Test
    void anApplicationsSettingsBeanReplacesTheOneFromProperties() {
        com.argusvane.datum.sandbox.runtime.SandboxSettings settings = com.argusvane.datum.sandbox.runtime.SandboxSettings.builder()
            .failFast(true).warmUpRuns(1).shutdownGrace(java.time.Duration.ofSeconds(3)).validationTimeLimit(java.time.Duration.ofSeconds(7))
            .formulaErrors("warn").unknownFields("reject").build();
        runner.withUserConfiguration(WithRuntime.class).withBean(com.argusvane.datum.sandbox.runtime.SandboxSettings.class, () -> settings)
            .withPropertyValues("datum.runtime.validation.time-limit=9s", "datum.host.formula-errors=fail").run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(context.getBean(com.argusvane.datum.sandbox.runtime.SandboxSettings.class)).isSameAs(settings);
                assertThat(context.getBean(ProgramLimits.class).validationSeconds()).as("limits read the application's settings").isEqualTo(7);
                assertThat(context.getBean(HostOptions.class).formulaErrors()).as("host options read them too").isEqualTo("warn");
                assertThat(context.getBean(DatumSandbox.class).explain().get("datum.runtime.validation.time-limit").value())
                    .isEqualTo(java.time.Duration.ofSeconds(7));
            });
    }

    /** The submissions capability reads the runtime of the context: its engine, release and mode, and what its store and throttle are. */
    @Test
    void theCapabilityNamesTheEngineAndTheThrottle() {
        runner.withUserConfiguration(WithRuntime.class).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(DatumCapabilities.class).details()).containsEntry("engineMode", "jffi").containsKey("engine")
                .containsEntry("engineRelease", "test").containsEntry("throttle", "memory");
        });
    }

    /** The development throttle's per-kind limits and bound (binding-level). */
    @Test
    void theDevelopmentThrottleTakesPerKindLimitsAndABoundOnWindows() {
        runner.withUserConfiguration(WithRuntime.class)
            .withPropertyValues("datum.web.throttle.limit=5", "datum.web.throttle.limits.validate=50", "datum.web.throttle.limits.submit=2",
                "datum.web.throttle.max-keys=32")
            .run(context -> {
                assertThat(context).hasNotFailed();
                com.argusvane.datum.submissions.spring.InMemorySubmissionThrottle throttle =
                    (com.argusvane.datum.submissions.spring.InMemorySubmissionThrottle) context.getBean(com.argusvane.datum.submissions.spi.SubmissionThrottle.class);
                assertThat(throttle.limit()).isEqualTo(5);
                assertThat(throttle.limitOf(com.argusvane.datum.submissions.spi.ThrottleKey.Kind.VALIDATE)).isEqualTo(50);
                assertThat(throttle.limitOf(com.argusvane.datum.submissions.spi.ThrottleKey.Kind.SUBMIT)).isEqualTo(2);
                assertThat(throttle.limitOf(com.argusvane.datum.submissions.spi.ThrottleKey.Kind.PDF)).as("not listed: the one limit").isEqualTo(5);
                assertThat(org.springframework.test.util.ReflectionTestUtils.getField(throttle, "maxKeys")).isEqualTo(32);
            });
        for (String[] bad : new String[][] {{"datum.web.throttle.max-keys=8", "datum.web.throttle.max-keys"},
            {"datum.web.throttle.limits.nonsense=3", "datum.web.throttle.limits"}, {"datum.web.throttle.limits.pdf=0", "datum.web.throttle.limits.pdf"}}) {
            runner.withUserConfiguration(WithRuntime.class).withPropertyValues(bad[0]).run(context -> {
                assertThat(context).as(bad[0]).hasFailed();
                assertThat(context.getStartupFailure()).as(bad[0]).hasStackTraceContaining(bad[1]);
            });
        }
    }

    /**
     * {@code datum.web.throttle.address-limit}: 600 by default, a whole number per window per address, 0 for none; a negative
     * number stops the start naming the property. The receiver counts a request under it before the body is read.
     */
    @Test
    void theDevelopmentThrottleTakesTheAddressLimit() {
        runner.withUserConfiguration(WithRuntime.class).run(context -> {
            com.argusvane.datum.submissions.spring.InMemorySubmissionThrottle throttle =
                (com.argusvane.datum.submissions.spring.InMemorySubmissionThrottle) context.getBean(com.argusvane.datum.submissions.spi.SubmissionThrottle.class);
            assertThat(throttle.addressLimit()).isEqualTo(600);
        });
        runner.withUserConfiguration(WithRuntime.class).withPropertyValues("datum.web.throttle.address-limit=2").run(context -> {
            assertThat(context).hasNotFailed();
            com.argusvane.datum.submissions.spring.InMemorySubmissionThrottle throttle =
                (com.argusvane.datum.submissions.spring.InMemorySubmissionThrottle) context.getBean(com.argusvane.datum.submissions.spi.SubmissionThrottle.class);
            assertThat(throttle.addressLimit()).isEqualTo(2);
            SubmissionReceiver receiver = context.getBean(SubmissionReceiver.class);
            SubmissionRequest from = new SubmissionRequest("application/json", java.util.Map.of(), "203.0.113.9", null);
            receiver.admit(from, com.argusvane.datum.submissions.spi.SubmissionMode.SUBMIT);
            receiver.admit(from, com.argusvane.datum.submissions.spi.SubmissionMode.VALIDATE);
            assertThatThrownBy(() -> receiver.admit(from, com.argusvane.datum.submissions.spi.SubmissionMode.TEST))
                .isInstanceOf(com.argusvane.datum.submissions.receiver.ThrottledException.class);
        });
        runner.withUserConfiguration(WithRuntime.class).withPropertyValues("datum.web.throttle.address-limit=0").run(context -> {
            com.argusvane.datum.submissions.spring.InMemorySubmissionThrottle throttle =
                (com.argusvane.datum.submissions.spring.InMemorySubmissionThrottle) context.getBean(com.argusvane.datum.submissions.spi.SubmissionThrottle.class);
            assertThat(throttle.addressLimit()).as("0 keeps no address limit").isZero();
        });
        runner.withUserConfiguration(WithRuntime.class).withPropertyValues("datum.web.throttle.address-limit=-1").run(context -> {
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure()).hasStackTraceContaining("datum.web.throttle.address-limit");
        });
        runner.withUserConfiguration(WithRuntime.class).withPropertyValues("datum.web.throttle.enabled=false", "datum.web.throttle.address-limit=1")
            .run(context -> {
                assertThat(context).doesNotHaveBean(com.argusvane.datum.submissions.spi.SubmissionThrottle.class);
                SubmissionRequest from = new SubmissionRequest("application/json", java.util.Map.of(), "203.0.113.9", null);
                for (int i = 0; i < 5; i++) {
                    context.getBean(SubmissionReceiver.class).admit(from, com.argusvane.datum.submissions.spi.SubmissionMode.SUBMIT);
                }
            });
    }

    /** The in-memory idempotency store's size is {@code datum.submissions.idempotency.memory-size}. */
    @Test
    void theInMemoryIdempotencyStoreTakesItsSizeFromAProperty() {
        runner.withUserConfiguration(WithRuntime.class).withPropertyValues("datum.submissions.idempotency.memory-size=64").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(org.springframework.test.util.ReflectionTestUtils.getField(
                context.getBean(com.argusvane.datum.submissions.spi.SubmissionIdempotencyStore.class), "maxEntries")).isEqualTo(64);
        });
        runner.withUserConfiguration(WithRuntime.class).withPropertyValues("datum.submissions.idempotency.memory-size=2").run(context -> {
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure()).hasStackTraceContaining("datum.submissions.idempotency.memory-size");
        });
    }
}
