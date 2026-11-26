package com.argusvane.datum.webauthn.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.submissions.spi.SubmissionSignatureCheck;
import com.argusvane.datum.webauthn.InMemoryPasskeyRepository;
import com.argusvane.datum.webauthn.PasskeyRepository;
import com.argusvane.datum.webauthn.PasskeySubjectResolver;
import com.argusvane.datum.webauthn.web.PasskeyThrottle;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.FilteredClassLoader;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/**
 * The "works without Spring Security, without datum-submissions, without Spring's
 * JDBC" paths are proved with the classes filtered out of the class loader, not assumed from the conditions' wording.
 */
class OptionalClassesTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(DatumWebAuthnAutoConfiguration.class))
        .withPropertyValues("datum.webauthn.enabled=true", "datum.webauthn.rp-id=example.org", "datum.webauthn.rp-name=Example",
            "datum.webauthn.origins=https://forms.example.org", "datum.webauthn.secret=a configured secret of at least 32 bytes!",
            "datum.webauthn.allow-memory-stores=true");

    @Test
    void withSpringSecurityThePrincipalIsSpringSecuritys() {
        runner.run(context -> assertThat(context.getBean(PasskeySubjectResolver.class)).isInstanceOf(SecurityPrincipalSubjectResolver.class));
    }

    @Test
    void withoutSpringSecurityTheRequestsPlainPrincipalNamesTheOwner() {
        runner.withClassLoader(new FilteredClassLoader("org.springframework.security")).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(PasskeySubjectResolver.class)).isNotInstanceOf(SecurityPrincipalSubjectResolver.class);
        });
    }

    @Test
    void withoutDatumSubmissionsThereIsNoSignatureCheckAndNoThrottleToShare() {
        runner.withClassLoader(new FilteredClassLoader("com.argusvane.datum.submissions")).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(PasskeyThrottle.class)).isSameAs(PasskeyThrottle.NONE);
        });
        runner.run(context -> assertThat(context).hasSingleBean(SubmissionSignatureCheck.class));
    }

    @Test
    void withoutSpringsJdbcTheStoresAreTheAcknowledgedInMemoryOnes() {
        runner.withClassLoader(new FilteredClassLoader("org.springframework.jdbc")).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(PasskeyRepository.class)).isInstanceOf(InMemoryPasskeyRepository.class);
        });
    }

    @Test
    void withoutSpringsJdbcAndWithoutTheAcknowledgementTheStartIsRefused() {
        new ApplicationContextRunner().withConfiguration(AutoConfigurations.of(DatumWebAuthnAutoConfiguration.class))
            .withClassLoader(new FilteredClassLoader("org.springframework.jdbc"))
            .withPropertyValues("datum.webauthn.enabled=true", "datum.webauthn.rp-id=example.org", "datum.webauthn.rp-name=Example",
                "datum.webauthn.origins=https://forms.example.org", "datum.webauthn.secret=a configured secret of at least 32 bytes!")
            .run(context -> assertThat(context).hasFailed().getFailure().hasStackTraceContaining("allow-memory-stores"));
    }
}
