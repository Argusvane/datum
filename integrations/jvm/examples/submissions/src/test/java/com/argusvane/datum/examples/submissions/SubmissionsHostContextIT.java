package com.argusvane.datum.examples.submissions;

import com.argusvane.datum.starter.test.DatumTck;
import com.argusvane.datum.submissions.spi.HostContextProvider;
import com.argusvane.datum.tck.HostContextContract;
import com.argusvane.datum.tck.HostTarget;
import com.argusvane.datum.tck.TckFixtures;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Tag;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;

/**
 * The host context over HTTP with the REAL runtime: this test deployment serves the kit's host context fixture
 * beside the example's form and wires the kit's TEST-ONLY provider, and the kit's {@link HostContextContract} checks that
 * the kernel judges {@code host.role} with the server's context and never with one the document carries. The provider
 * reads a header a client chooses ({@link TckFixtures#TEST_ROLE_HEADER}), so it belongs to this test alone and never to
 * the example's own configuration: a real host derives the role from its session.
 */
@Tag("real-runtime")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "datum.web.api.endpoints.test=true",
    "datum.forms.locations=classpath:/datum/forms/*.json," + DatumTck.HOST_CONTEXT_FORM_LOCATION})
class SubmissionsHostContextIT implements HostContextContract {

    /** The kit's TEST-ONLY provider: for the fixture form only, {@code {"role": <header>}} when the header is sent, else none. */
    @TestConfiguration(proxyBeanMethods = false)
    static class TestRoleHostContext {

        @Bean
        HostContextProvider datumTckTestRole() {
            return request -> {
                if (!TckFixtures.HOST_CONTEXT_FORM.equals(request.formKey())) {
                    return Optional.empty();
                }
                String role = request.submission().header(TckFixtures.TEST_ROLE_HEADER);
                return role == null ? Optional.empty() : Optional.of(Map.of("role", role));
            };
        }
    }

    @LocalServerPort
    int port;

    @Override
    public HostTarget target() {
        return DatumTck.local(port);
    }
}
