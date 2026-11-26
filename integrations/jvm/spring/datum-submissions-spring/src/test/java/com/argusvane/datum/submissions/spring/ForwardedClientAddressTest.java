package com.argusvane.datum.submissions.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.CountedAddress;
import com.argusvane.datum.springweb.mvc.MvcRequestViews;
import com.argusvane.datum.springweb.webflux.WebFluxRequestViews;
import com.argusvane.datum.submissions.spi.ThrottleDecision;
import com.argusvane.datum.submissions.spi.ThrottleKey;
import com.argusvane.datum.submissions.spring.InMemorySubmissionThrottle.By;
import jakarta.servlet.http.HttpServletRequest;
import java.net.InetSocketAddress;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BiFunction;
import java.util.stream.Stream;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.web.filter.ForwardedHeaderFilter;
import org.springframework.web.reactive.function.server.HandlerStrategies;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.server.adapter.ForwardedHeaderTransformer;

/**
 * Behind a proxy the client address is the one Spring's forwarded-header handling leaves, and that handling reports an
 * IPv6 client in brackets ({@code [2001:db8:1:2::1]}). Two addresses of one /64 sent through it still count in one
 * window, on the servlet stack ({@code ForwardedHeaderFilter}) and the reactive one ({@code ForwardedHeaderTransformer})
 * alike, read through the same request views the submission routes build their keys from.
 */
class ForwardedClientAddressTest {

    /** The proxy's own address, which the forwarded headers replace. */
    private static final String PROXY = "10.0.0.9";

    /** The remote address the submission routes would see on the servlet stack behind {@code ForwardedHeaderFilter}. */
    private static String throughMvc(String header, String value) {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/datum/submissions/contact");
        request.setRemoteAddr(PROXY);
        request.addHeader(header, value);
        AtomicReference<String> seen = new AtomicReference<>();
        try {
            new ForwardedHeaderFilter().doFilter(request, new MockHttpServletResponse(),
                (forwarded, response) -> seen.set(MvcRequestViews.remoteAddress((HttpServletRequest) forwarded)));
        } catch (Exception e) {
            throw new AssertionError(e);
        }
        return seen.get();
    }

    /** The remote address the submission routes would see on the reactive stack behind {@code ForwardedHeaderTransformer}. */
    private static String throughWebFlux(String header, String value) {
        MockServerHttpRequest request = MockServerHttpRequest.post("/datum/submissions/contact")
            .remoteAddress(new InetSocketAddress(PROXY, 443))
            .header(header, value)
            .build();
        ServerHttpRequest forwarded = new ForwardedHeaderTransformer().apply(request);
        MockServerWebExchange exchange = MockServerWebExchange.from(request);
        ServerRequest server = ServerRequest.create(exchange.mutate().request(forwarded).build(), HandlerStrategies.withDefaults().messageReaders());
        return WebFluxRequestViews.remoteAddress(server);
    }

    static Stream<Arguments> forwarded() {
        BiFunction<String, String, String> mvc = ForwardedClientAddressTest::throughMvc;
        BiFunction<String, String, String> webFlux = ForwardedClientAddressTest::throughWebFlux;
        return Stream.of(mvc, webFlux).flatMap(stack -> Stream.of(
            Arguments.of(stack, "X-Forwarded-For", "%s"),
            Arguments.of(stack, "X-Forwarded-For", "%s, 10.0.0.8"),
            Arguments.of(stack, "X-Forwarded-For", "[%s]:4711"),
            Arguments.of(stack, "Forwarded", "for=\"[%s]\";proto=https"),
            Arguments.of(stack, "Forwarded", "for=\"[%s]:4711\"")));
    }

    @ParameterizedTest
    @MethodSource("forwarded")
    void twoAddressesOfOneSlash64ThroughForwardedHeadersShareOneWindow(BiFunction<String, String, String> stack, String header,
                                                                        String format) {
        String first = stack.apply(header, format.formatted("2001:db8:1:2::1"));
        String second = stack.apply(header, format.formatted("2001:db8:1:2::2"));
        String otherNetwork = stack.apply(header, format.formatted("2001:db8:1:3::1"));
        // The shape the counter has to read: the brackets stay, the proxy's address is gone.
        assertThat(first).startsWith("[2001:db8:1:2::1]").doesNotContain(PROXY);
        assertThat(CountedAddress.of(first)).isEqualTo("2001:db8:1:2::/64");

        InMemorySubmissionThrottle throttle = new InMemorySubmissionThrottle(2, Duration.ofMinutes(1), List.of(By.IP), Clock.systemUTC(), 100);
        throttle.record(new ThrottleKey(first, "contact", null, ThrottleKey.Kind.SUBMIT));
        throttle.record(new ThrottleKey(second, "contact", null, ThrottleKey.Kind.SUBMIT));
        assertThat(throttle.size()).as("one window for the /64").isEqualTo(1);
        assertThat(throttle.check(new ThrottleKey(stack.apply(header, format.formatted("2001:db8:1:2::3")), "contact", null,
            ThrottleKey.Kind.SUBMIT))).isInstanceOf(ThrottleDecision.Deny.class);
        assertThat(throttle.check(new ThrottleKey(otherNetwork, "contact", null, ThrottleKey.Kind.SUBMIT))).as("another /64 counts alone")
            .isEqualTo(ThrottleDecision.ALLOW);
    }

    static Stream<BiFunction<String, String, String>> stacks() {
        return Stream.of(ForwardedClientAddressTest::throughMvc, ForwardedClientAddressTest::throughWebFlux);
    }

    @ParameterizedTest
    @MethodSource("stacks")
    void anIpv4ClientForwardedWithItsPortIsCountedByItsAddress(BiFunction<String, String, String> stack) {
        // X-Forwarded-For brackets any entry holding a colon, so a proxy that writes the client's port reports it as
        // [203.0.113.7:4711]; each connection would otherwise be a key of its own.
        String first = stack.apply("X-Forwarded-For", "203.0.113.7:4711");
        String second = stack.apply("X-Forwarded-For", "203.0.113.7:4712");
        assertThat(CountedAddress.of(first)).isEqualTo("203.0.113.7");

        InMemorySubmissionThrottle throttle = new InMemorySubmissionThrottle(1, Duration.ofMinutes(1), List.of(By.IP), Clock.systemUTC(), 100);
        throttle.record(new ThrottleKey(first, "contact", null, ThrottleKey.Kind.SUBMIT));
        assertThat(throttle.check(new ThrottleKey(second, "contact", null, ThrottleKey.Kind.SUBMIT)))
            .as("another connection of one client").isInstanceOf(ThrottleDecision.Deny.class);
    }
}
