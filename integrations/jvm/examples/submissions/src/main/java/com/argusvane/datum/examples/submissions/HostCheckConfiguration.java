package com.argusvane.datum.examples.submissions;

import com.argusvane.datum.submissions.spi.HostContextProvider;
import java.util.Map;
import java.util.Optional;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;

/**
 * TEST WIRING for an external {@code datum-host-check} run (packages/conformance-suite, host conformance). It is active only under the Spring profile {@code host-check} and must never be enabled where real
 * submissions are taken: the provider below believes a request header a client chooses.
 *
 * <p>With the profile on, {@code application-host-check.yml} also switches the dry-run route on, serves the kit's host
 * context fixture form beside the example's own, registers the kit's hostile rule module for the fixture form (through
 * {@link HardeningRulesConfiguration}) and raises the validation memory so the module's 40 MiB answer meets the run's
 * output caps. All of it reads one property, {@code datum.example.host-check-fixtures}, the directory that
 * {@code datum-host-check fixtures --out <dir>} wrote. {@code SubmissionsHostContextIT} wires the same provider in
 * process from the kit's own classes; the kit is a test-scope dependency of this example, so the few lines are repeated
 * here and the two are kept equal by the form key and header name being the kit's ({@code TckFixtures.HOST_CONTEXT_FORM},
 * {@code TckFixtures.TEST_ROLE_HEADER}).
 */
@Configuration(proxyBeanMethods = false)
@Profile("host-check")
class HostCheckConfiguration {

    /** The kit's host context fixture form; the provider supplies a context for it and for no other form. */
    private static final String HOST_CONTEXT_FORM = "datum-host-context";

    /** The request header that stands in for a session: a real host derives the role from who is signed in. */
    private static final String TEST_ROLE_HEADER = "X-Datum-Test-Role";

    /** For the fixture form only, {@code {"role": <header>}} when the header is sent, else no context. */
    @Bean
    HostContextProvider hostCheckTestRole() {
        return request -> {
            if (!HOST_CONTEXT_FORM.equals(request.formKey())) {
                return Optional.empty();
            }
            String role = request.submission().header(TEST_ROLE_HEADER);
            return role == null ? Optional.empty() : Optional.of(Map.of("role", role));
        };
    }
}
