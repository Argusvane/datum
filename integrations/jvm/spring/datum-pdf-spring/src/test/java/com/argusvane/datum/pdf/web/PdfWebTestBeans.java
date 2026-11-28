package com.argusvane.datum.pdf.web;

import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.sandbox.protocol.RunSlots;
import com.argusvane.datum.pdf.PdfRuntime;
import com.argusvane.datum.pdf.PdfService;
import com.argusvane.datum.pdf.ScriptedPdfRuntime;
import com.argusvane.datum.pdf.SealPreset;
import com.argusvane.datum.pdf.TestAssets;
import com.argusvane.datum.pdf.api.AnswerCheck;
import com.argusvane.datum.pdf.api.CheckedAnswers;
import com.argusvane.datum.pdf.api.PdfApi;
import com.argusvane.datum.springweb.spring.DatumProperties;
import com.argusvane.datum.submissions.spi.SubmissionError;
import com.argusvane.datum.submissions.spi.SubmissionThrottle;
import com.argusvane.datum.submissions.spi.ThrottleDecision;
import com.argusvane.datum.submissions.spi.ThrottleKey;
import com.argusvane.datum.web.json.DatumJsonMapper;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import com.argusvane.datum.springweb.mvc.DatumRequestMatchers;
import com.argusvane.datum.springweb.mvc.DatumSecurityResponses;
import com.argusvane.datum.springweb.webflux.DatumExchangeMatchers;
import com.argusvane.datum.springweb.webflux.DatumServerSecurityResponses;
import jakarta.servlet.FilterChain;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication.Type;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.reactive.EnableWebFluxSecurity;
import org.springframework.security.config.web.server.SecurityWebFiltersOrder;
import org.springframework.security.config.web.server.ServerHttpSecurity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.ReactiveSecurityContextHolder;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.core.context.SecurityContextImpl;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.access.intercept.AuthorizationFilter;
import org.springframework.security.web.server.SecurityWebFilterChain;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.server.WebFilter;
import tools.jackson.databind.node.ObjectNode;

/**
 * What the web tests plug into the PDF endpoints, in place of datum-submissions' receiver and a real runtime: a
 * scripted PDF program, a check a test can make refuse, a throttle a test can close, a runtime a test can take down,
 * and the application's security (framework-first): a Spring Security chain per stack written with
 * datum-spring-web's matchers and JSON handlers, whose caller may print ({@code pdf()}) unless an {@code X-Deny}
 * header names {@code submit} or {@code read} (the two questions the access policy asks before a print). The adapters under
 * test are the real ones ({@code PdfWebConfiguration}'s stack configurations); only the collaborators are doubles.
 */
@Configuration(proxyBeanMethods = false)
public class PdfWebTestBeans {

    static final String DEFINITION = "{\"id\":\"intake\",\"version\":\"3\",\"root\":{\"id\":\"root\",\"type\":\"form\",\"configuration\":{},"
        + "\"children\":{\"content\":[]}},\"pdf\":{\"layouts\":[{\"id\":\"copy\",\"kind\":\"generated\"},{\"id\":\"form-a\",\"kind\":\"template\"}]}}";

    static final String ENVELOPE = "{\"versionContext\":{\"form\":{\"id\":\"intake\",\"version\":\"3\"}},\"submission\":{\"values\":{\"name\":\"<b>x</b>\"},"
        + "\"locale\":\"fr\"}}";

    /** The state a test reads and sets. */
    public static final class Probe {

        public final ScriptedPdfRuntime runtime = new ScriptedPdfRuntime();
        public volatile boolean refuse;
        public volatile boolean down;
        /** The PDF program starts and then fails the run (the module traps): a run that gave no answer. */
        public volatile boolean runFails;
        public volatile Duration throttled;
        /** The address limit closed for this long, or null while it is open. */
        public volatile Duration addressThrottled;
        /** The addresses the address limit counted. */
        public final List<String> addressesCounted = new java.util.concurrent.CopyOnWriteArrayList<>();
        /** What the application's PdfResultValidator answers: null lets every PDF go, else refuse, forbid or throw. */
        public volatile String verdict;
        /** The PdfRenderedEvents the service published since the last reset. */
        public final List<Object> events = java.util.Collections.synchronizedList(new java.util.ArrayList<>());
        private volatile int baseline;

        public void reset() {
            refuse = false;
            down = false;
            runFails = false;
            throttled = null;
            addressThrottled = null;
            addressesCounted.clear();
            verdict = null;
            events.clear();
            // The scripted program lives as long as the application: a test counts what came after its own reset.
            baseline = runtime.requests().size();
        }

        /** The program's requests since the last reset. */
        public List<ScriptedPdfRuntime.Request> requests() {
            List<ScriptedPdfRuntime.Request> all = runtime.requests();
            return all.subList(Math.min(baseline, all.size()), all.size());
        }

        public List<ObjectNode> requests(String op) {
            return requests().stream().filter(r -> r.op().equals(op)).map(ScriptedPdfRuntime.Request::body).toList();
        }

    }

    @Bean
    Probe probe() {
        return new Probe();
    }

    @Bean
    PdfRoutes datumPdfRoutes(com.argusvane.datum.web.WebSettings settings) {
        return new PdfRoutes(settings);
    }

    @Bean
    PdfService pdfService(Probe probe) {
        PdfRuntime scripted = probe.runtime.pdfRuntime();
        PdfRuntime switchable = new PdfRuntime() {
            @Override
            public com.argusvane.datum.sandbox.protocol.PdfKernel program() {
                if (probe.down) {
                    throw new ProgramUnavailableException("The PDF program is not available.");
                }
                com.argusvane.datum.sandbox.protocol.PdfKernel kernel = scripted.program();
                if (!probe.runFails) {
                    return kernel;
                }
                return new com.argusvane.datum.sandbox.protocol.PdfKernel() {
                    @Override
                    public com.argusvane.datum.sandbox.protocol.Program program() {
                        return kernel.program();
                    }

                    @Override
                    public com.argusvane.datum.core.contracts.PdfCapabilitiesResponse capabilities() {
                        return kernel.capabilities();
                    }

                    @Override
                    public ObjectNode call(ObjectNode request) {
                        throw new com.argusvane.datum.sandbox.protocol.SandboxException(
                            com.argusvane.datum.sandbox.protocol.SandboxException.Reason.TRAP, "the module trapped", "SECRET GUEST STDERR");
                    }
                };
            }

            @Override
            public RunSlots slots() {
                return scripted.slots();
            }

            @Override
            public com.argusvane.datum.sandbox.wasi.EngineInfo engine() {
                return scripted.engine();
            }

            @Override
            public Map<String, String> contextKeys() {
                return scripted.contextKeys();
            }

            @Override
            public int pdfSeconds() {
                return scripted.pdfSeconds();
            }
        };
        // The application's PdfResultValidator, steered by the probe, and an event sink the tests read.
        com.argusvane.datum.pdf.PdfResultValidator validator = candidate -> {
            String verdict = probe.verdict;
            if (verdict == null) {
                return com.argusvane.datum.core.hooks.HookFindings.NONE;
            }
            return switch (verdict) {
                case "refuse" -> com.argusvane.datum.core.hooks.HookFindings.errors(
                    com.argusvane.datum.core.hooks.HookProblem.at("pages", "pdf.tooManyPages", "This PDF has more pages than the policy allows."),
                    com.argusvane.datum.core.hooks.HookProblem.of("pdf.tooLarge", "This PDF is larger than the policy allows."));
                case "forbid" -> throw com.argusvane.datum.core.hooks.HookRefusedException.forbidden("pdf.tenant", "Printing is closed for your organization.");
                default -> throw new IllegalStateException("the page policy service is down /secret/path");
            };
        };
        return PdfService.builder().runtime(switchable).signer(TestAssets.signer("chain-leaf")).seal(SealPreset.on()).verifyMaxBytes(2048)
            .validators(List.of(validator)).events(probe.events::add).build();
    }

    @Bean
    PdfApi pdfApi(PdfService pdf, Probe probe, DatumJsonMapper json) {
        AnswerCheck check = (request, body) -> {
            if (probe.refuse) {
                return new CheckedAnswers(false, "sandbox", List.of(SubmissionError.error("name", "required", null)), null);
            }
            return new CheckedAnswers(true, null, List.of(), (ObjectNode) TestAssets.JSON.readTree("{\"name\":\"x\"}"));
        };
        SubmissionThrottle throttle = new SubmissionThrottle() {
            @Override
            public ThrottleDecision check(ThrottleKey key) {
                Duration closed = probe.throttled;
                return closed == null ? ThrottleDecision.ALLOW : new ThrottleDecision.Deny(closed);
            }

            @Override
            public void record(ThrottleKey key) {
            }

            @Override
            public ThrottleDecision checkAddress(String address) {
                Duration closed = probe.addressThrottled;
                return closed == null ? ThrottleDecision.ALLOW : new ThrottleDecision.Deny(closed);
            }

            @Override
            public void recordAddress(String address) {
                probe.addressesCounted.add(address);
            }
        };
        return PdfApi.builder().pdf(pdf).check(check).definitions(key -> (ObjectNode) TestAssets.JSON.readTree(DEFINITION))
            .throttle(throttle).json(json).maxBodyBytes(16 * 1024).build();
    }

    /** The caller of a request: may print unless {@code X-Deny} names submit or read. */
    static Authentication caller(String denied) {
        List<String> named = denied == null ? List.of() : List.of(denied.split(","));
        boolean print = !named.contains("submit") && !named.contains("read");
        return new TestingAuthenticationToken("tester", "n/a", print ? new String[] {"print"} : new String[0]);
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.SERVLET)
    @EnableWebSecurity
    static class ServletSecurity {

        @Bean
        SecurityFilterChain testChain(HttpSecurity http, DatumRequestMatchers datum, DatumSecurityResponses responses) throws Exception {
            return http
                .authorizeHttpRequests(requests -> requests
                    .requestMatchers(datum.pdf()).hasAuthority("print")
                    .anyRequest().permitAll())
                .csrf(csrf -> csrf.disable())
                .addFilterBefore(new OncePerRequestFilter() {
                    @Override
                    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
                        throws jakarta.servlet.ServletException, java.io.IOException {
                        SecurityContextHolder.setContext(new SecurityContextImpl(caller(request.getHeader("X-Deny"))));
                        chain.doFilter(request, response);
                    }
                }, AuthorizationFilter.class)
                .exceptionHandling(exceptions -> exceptions.accessDeniedHandler(responses.accessDeniedHandler()))
                .build();
        }
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.REACTIVE)
    @EnableWebFluxSecurity
    static class ReactiveSecurity {

        @Bean
        SecurityWebFilterChain testChain(ServerHttpSecurity http, DatumExchangeMatchers datum, DatumServerSecurityResponses responses) {
            WebFilter caller = (exchange, chain) -> chain.filter(exchange)
                .contextWrite(ReactiveSecurityContextHolder.withAuthentication(caller(exchange.getRequest().getHeaders().getFirst("X-Deny"))));
            return http
                .authorizeExchange(exchanges -> exchanges
                    .matchers(datum.pdf()).hasAuthority("print")
                    .anyExchange().permitAll())
                .csrf(ServerHttpSecurity.CsrfSpec::disable)
                .addFilterAt(caller, SecurityWebFiltersOrder.AUTHENTICATION)
                .exceptionHandling(exceptions -> exceptions.accessDeniedHandler(responses.accessDeniedHandler()))
                .build();
        }
    }
}
