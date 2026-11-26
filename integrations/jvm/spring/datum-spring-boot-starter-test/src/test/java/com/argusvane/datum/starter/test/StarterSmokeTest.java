package com.argusvane.datum.starter.test;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.forms.spring.DatumFormsAutoConfiguration;
import com.argusvane.datum.forms.spring.DatumFormsWebAutoConfiguration;
import com.argusvane.datum.pdf.PdfService;
import com.argusvane.datum.pdf.spring.DatumPdfAutoConfiguration;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import com.argusvane.datum.submissions.receiver.SubmissionReceiver;
import com.argusvane.datum.sandbox.runtime.DatumSandbox;
import com.argusvane.datum.sandbox.runtime.SandboxStatus;
import com.argusvane.datum.sandbox.spring.DatumSandboxAutoConfiguration;
import com.argusvane.datum.submissions.spring.DatumSubmissionsAutoConfiguration;
import com.argusvane.datum.timestamp.TimestampAuthority;
import com.argusvane.datum.timestamp.spring.DatumTimestampAutoConfiguration;
import com.argusvane.datum.ui.spring.DatumBuilderAutoConfiguration;
import com.argusvane.datum.ui.spring.DatumBuilderServiceAutoConfiguration;
import com.argusvane.datum.ui.spring.DatumUiAutoConfiguration;
import com.argusvane.datum.webauthn.RegistrationCeremony;
import com.argusvane.datum.webauthn.spring.DatumWebAuthnAutoConfiguration;
import com.argusvane.datum.webauthn.spring.DatumWebAuthnWebAutoConfiguration;
import java.util.function.Consumer;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.EnumSource;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.context.annotation.ImportCandidates;
import org.springframework.boot.test.context.assertj.ApplicationContextAssertProvider;
import org.springframework.boot.test.context.runner.AbstractApplicationContextRunner;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.test.context.runner.ReactiveWebApplicationContextRunner;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * The starters have no tests of their own: this one starts, for each starter, the
 * auto-configurations that starter brings, on the Servlet and the reactive stack, with the fake runtime in place
 * of the engine, and asserts the context starts and the capability's main bean is there. The starters are on this
 * module's test class path, so a jar that dropped a class a starter needs fails here too.
 */
class StarterSmokeTest {

    private static final Class<?>[] SUBMISSIONS = {DatumWebAutoConfiguration.class, DatumFormsAutoConfiguration.class,
        DatumFormsWebAutoConfiguration.class, DatumSandboxAutoConfiguration.class, DatumSubmissionsAutoConfiguration.class};

    enum Stack {
        SERVLET, REACTIVE
    }

    /** What the context offers a check: assertions and beans, whichever stack made it. */
    private interface Check extends Consumer<ApplicationContextAssertProvider<?, ? extends ConfigurableApplicationContext>> {
    }

    private static void start(Stack stack, Class<?>[] configurations, String[] properties, Check check) {
        if (stack == Stack.SERVLET) {
            configure(new WebApplicationContextRunner(), configurations, properties).run(context -> verify(context, check));
        } else {
            configure(new ReactiveWebApplicationContextRunner(), configurations, properties).run(context -> verify(context, check));
        }
    }

    private static <R extends AbstractApplicationContextRunner<R, C, A>, C extends ConfigurableApplicationContext,
        A extends ApplicationContextAssertProvider<A, C>> R configure(R runner, Class<?>[] configurations, String[] properties) {
        return runner.withConfiguration(AutoConfigurations.of(DatumTestAutoConfiguration.class, DatumTestFormsAutoConfiguration.class))
            .withPropertyValues("datum.test.forms=true")
            .withConfiguration(AutoConfigurations.of(configurations))
            .withPropertyValues(properties);
    }

    private static void verify(ApplicationContextAssertProvider<?, ? extends ConfigurableApplicationContext> context, Check check) {
        assertThat(context).hasNotFailed();
        check.accept(context);
    }

    private static Class<?>[] plus(Class<?>[] base, Class<?>... more) {
        Class<?>[] all = java.util.Arrays.copyOf(base, base.length + more.length);
        System.arraycopy(more, 0, all, base.length, more.length);
        return all;
    }

    @ParameterizedTest
    @EnumSource(Stack.class)
    void theSubmissionsStarterStartsWithTheRuntimeUp(Stack stack) {
        start(stack, SUBMISSIONS, new String[0], context -> {
            assertThat(context).hasSingleBean(SubmissionReceiver.class).hasSingleBean(DatumSandbox.class);
            assertThat(context.getBean(DatumSandbox.class).status().state()).isEqualTo(SandboxStatus.State.UP);
        });
    }

    @ParameterizedTest
    @EnumSource(Stack.class)
    void theUiStarterStartsWithAndWithoutTheBuilder(Stack stack) {
        Class<?>[] ui = plus(SUBMISSIONS, DatumUiAutoConfiguration.class, DatumBuilderServiceAutoConfiguration.class, DatumBuilderAutoConfiguration.class);
        start(stack, ui, new String[0], context -> assertThat(context).doesNotHaveBean("datumBuilderApi"));
        start(stack, ui, new String[] {"datum.builder.enabled=true"}, context -> assertThat(context).hasBean("datumBuilderApi"));
    }

    @ParameterizedTest
    @EnumSource(Stack.class)
    void thePdfStarterStartsAndTheProgramIsAvailable(Stack stack) {
        start(stack, plus(SUBMISSIONS, DatumPdfAutoConfiguration.class), new String[0], context -> {
            assertThat(context).hasSingleBean(PdfService.class);
            assertThat(context.getBean(DatumSandbox.class).status().pdfAbi()).isNotEqualTo("unavailable");
        });
    }

    @ParameterizedTest
    @EnumSource(Stack.class)
    void theTimestampStarterStartsWithoutTheSubmissionsModules(Stack stack) {
        start(stack, new Class<?>[] {DatumWebAutoConfiguration.class, DatumTimestampAutoConfiguration.class},
            new String[] {"datum.tsa.enabled=true", "datum.tsa.allow-memory-stores=true", "datum.tsa.signer.self-signed=true"},
            context -> assertThat(context).hasSingleBean(TimestampAuthority.class));
    }

    @ParameterizedTest
    @EnumSource(Stack.class)
    void theWebauthnStarterStartsOnceTheMemoryStoresAreAcknowledged(Stack stack) {
        Class<?>[] passkeys = plus(SUBMISSIONS, DatumWebAuthnAutoConfiguration.class, DatumWebAuthnWebAutoConfiguration.class);
        String[] properties = {"datum.webauthn.enabled=true", "datum.webauthn.allow-memory-stores=true", "datum.webauthn.rp-id=localhost",
            "datum.webauthn.origins=http://localhost:8080", "datum.webauthn.secret=an-example-secret-that-is-at-least-32-bytes-long"};
        start(stack, passkeys, properties, context -> assertThat(context).hasSingleBean(RegistrationCeremony.class));
    }

    @Test
    void webauthnRefusesToStartWithoutAStoreOrTheAcknowledgement() {
        Supplier<ApplicationContextRunner> runner = ApplicationContextRunner::new;
        runner.get().withConfiguration(AutoConfigurations.of(DatumTestAutoConfiguration.class, DatumTestFormsAutoConfiguration.class))
            .withPropertyValues("datum.test.forms=true")
            .withConfiguration(AutoConfigurations.of(plus(SUBMISSIONS, DatumWebAuthnAutoConfiguration.class)))
            .withPropertyValues("datum.webauthn.enabled=true", "datum.webauthn.rp-id=localhost",
                "datum.webauthn.origins=http://localhost:8080", "datum.webauthn.secret=an-example-secret-that-is-at-least-32-bytes-long")
            .run(context -> {
                assertThat(context).hasFailed();
                // The reason matters: any other failure (a missing bean in this setup) must not pass for the guard.
                Throwable root = context.getStartupFailure();
                while (root.getCause() != null) {
                    root = root.getCause();
                }
                assertThat(root.getMessage()).contains("datum.webauthn.allow-memory-stores=true");
            });
    }

    /**
     * Each starter's own jar names the auto-configurations this test starts: the imports file is what a real
     * application discovers, so a class dropped from (or never added to) it must fail here, not only in an example.
     */
    /**
     * Datum's auto-configurations are {@code public final} (not API to extend, as
     * Boot's are), their nested configurations are not public (nothing to {@code @Import}), and the autoconfigure processor
     * wrote the metadata Boot filters them with (so the class conditions are read before a class is loaded).
     */
    @Test
    void theAutoConfigurationsAreFinalWithPackagePrivateNestedConfigurationsAndHaveFilterMetadata() throws Exception {
        java.util.List<String> datum = ImportCandidates.load(AutoConfiguration.class, getClass().getClassLoader()).getCandidates().stream()
            .filter(name -> name.startsWith("com.argusvane.datum.")).toList();
        assertThat(datum).hasSizeGreaterThanOrEqualTo(20);
        for (String name : datum) {
            Class<?> type = Class.forName(name);
            assertThat(java.lang.reflect.Modifier.isPublic(type.getModifiers())).as(name + " is public").isTrue();
            assertThat(java.lang.reflect.Modifier.isFinal(type.getModifiers())).as(name + " is final").isTrue();
            for (Class<?> nested : type.getDeclaredClasses()) {
                assertThat(java.lang.reflect.Modifier.isPublic(nested.getModifiers())).as(nested.getName() + " is not public").isFalse();
            }
        }
        java.util.Set<String> keys = new java.util.HashSet<>();
        for (java.net.URL url : java.util.Collections.list(getClass().getClassLoader().getResources("META-INF/spring-autoconfigure-metadata.properties"))) {
            java.util.Properties metadata = new java.util.Properties();
            try (java.io.InputStream in = url.openStream()) {
                metadata.load(in);
            }
            keys.addAll(metadata.stringPropertyNames());
        }
        assertThat(keys).as("autoconfigure metadata").anyMatch(key -> key.startsWith("com.argusvane.datum.") && key.endsWith(".ConditionalOnClass"));
        for (String name : datum) {
            assertThat(keys).as("metadata lists " + name).contains(name);
        }
    }

    @Test
    void everyAutoConfigurationTheStartersBringIsListedInAnImportsFile() {
        java.util.List<String> listed = ImportCandidates.load(AutoConfiguration.class, getClass().getClassLoader()).getCandidates();
        for (Class<?> expected : new Class<?>[] {DatumWebAutoConfiguration.class, DatumFormsAutoConfiguration.class,
            DatumFormsWebAutoConfiguration.class, DatumSandboxAutoConfiguration.class, DatumSubmissionsAutoConfiguration.class, DatumUiAutoConfiguration.class,
            DatumBuilderAutoConfiguration.class, DatumPdfAutoConfiguration.class, DatumTimestampAutoConfiguration.class,
            DatumWebAuthnAutoConfiguration.class, DatumWebAuthnWebAutoConfiguration.class}) {
            assertThat(listed).as("AutoConfiguration.imports lists %s", expected.getName()).contains(expected.getName());
        }
    }

    /**
     * "Each starter alone": the starters sit side by side on this class path, so a pom that dropped a dependency would
     * still resolve here. The poms are read directly instead and must name what the starter promises.
     */
    @ParameterizedTest
    @CsvSource({
        "submissions,'datum-core,datum-programs,datum-sandbox-endive,datum-sandbox-endive-jffi,datum-sandbox-endive-panama,datum-spring-web,datum-sandbox-spring,datum-forms-spring,datum-submissions-spring'",
        "ui,'datum-spring-boot-starter-submissions,datum-ui-spring'",
        "pdf,'datum-pdf-spring,datum-sandbox-spring,datum-timestamp-spring,datum-spring-boot-starter-submissions'",
        "timestamp,'datum-timestamp-spring'",
        "webauthn,'datum-webauthn-spring,datum-spring-boot-starter-submissions'"})
    void eachStarterPomNamesWhatItBrings(String starter, String artifacts) throws java.io.IOException {
        java.nio.file.Path pom = java.nio.file.Path.of("..", "datum-spring-boot-starter-" + starter, "pom.xml");
        org.junit.jupiter.api.Assumptions.assumeTrue(java.nio.file.Files.exists(pom), "the reactor checkout is not beside this module");
        String text = java.nio.file.Files.readString(pom);
        for (String artifact : artifacts.split(",")) {
            assertThat(text).as("starter-%s depends on %s", starter, artifact).contains("<artifactId>" + artifact + "</artifactId>");
        }
    }

    /**
     * The starters bring the Spring bindings, and each binding brings its framework-free library
     * and the shared Spring web adapters, so a consumer's pom is unchanged: read the binding poms as the starters' are.
     */
    @ParameterizedTest
    @CsvSource({
        "forms,'datum-forms,datum-spring-web'",
        "sandbox,'datum-sandbox,datum-spring-web'",
        "submissions,'datum-submissions,datum-spring-web,datum-sandbox-spring,datum-forms-spring'",
        "ui,'datum-ui,datum-spring-web,datum-forms-spring'",
        "pdf,'datum-pdf,datum-spring-web,datum-forms-spring,datum-sandbox-spring,datum-submissions-spring'",
        "timestamp,'datum-timestamp,datum-spring-web'",
        "webauthn,'datum-webauthn,datum-spring-web,datum-forms-spring,datum-submissions-spring'"})
    void eachBindingPomNamesItsLibrary(String capability, String artifacts) throws java.io.IOException {
        java.nio.file.Path pom = java.nio.file.Path.of("..", "datum-" + capability + "-spring", "pom.xml");
        org.junit.jupiter.api.Assumptions.assumeTrue(java.nio.file.Files.exists(pom), "the reactor checkout is not beside this module");
        String text = java.nio.file.Files.readString(pom);
        for (String artifact : artifacts.split(",")) {
            assertThat(text).as("datum-%s-spring depends on %s", capability, artifact).contains("<artifactId>" + artifact + "</artifactId>");
        }
    }
}
