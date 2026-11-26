package com.argusvane.datum.springweb.autoconfigure;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.DatumStartupCheck;
import com.argusvane.datum.springweb.mvc.DatumRequestMatchers;
import com.argusvane.datum.springweb.mvc.DatumSecurityResponses;
import com.argusvane.datum.springweb.spring.DatumRouteBase;
import com.argusvane.datum.springweb.webflux.DatumExchangeMatchers;
import com.argusvane.datum.springweb.webflux.DatumServerSecurityResponses;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base;
import com.argusvane.datum.web.security.SecurityStartupCheck.Facts;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ReactiveWebApplicationContextRunner;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.security.config.annotation.web.reactive.EnableWebFluxSecurity;
import org.springframework.security.core.userdetails.MapReactiveUserDetailsService;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.web.DefaultSecurityFilterChain;
import org.springframework.security.web.server.SecurityWebFilterChain;
import org.springframework.security.web.server.WebFilterChainProxy;
import org.springframework.security.web.util.matcher.AnyRequestMatcher;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * The matchers and the JSON handlers exist per stack with Spring Security on the classpath, and
 * the start-up WARN's facts are read from the capability route beans, {@code datum.tsa.access} and a chain bean of
 * the stack's own type.
 */
class DatumSecurityAutoConfigurationTest {

    private static final String SERVLET_CHAIN = "org.springframework.security.web.SecurityFilterChain";
    private static final String REACTIVE_CHAIN = "org.springframework.security.web.server.SecurityWebFilterChain";

    private static DefaultListableBeanFactory routes(String... names) {
        DefaultListableBeanFactory factory = new DefaultListableBeanFactory();
        for (String name : names) {
            factory.registerSingleton(name, new Object());
        }
        return factory;
    }

    /** Without Spring Security on the class path the matchers and handlers are simply absent, and the start still works. */
    @Test
    void withoutSpringSecurityOnTheClassPathThereAreNoMatchersAndTheStartWorks() {
        new WebApplicationContextRunner()
            .withClassLoader(new org.springframework.boot.test.context.FilteredClassLoader("org.springframework.security"))
            .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumSecurityAutoConfiguration.class))
            .run(context -> {
                assertThat(context).hasNotFailed().doesNotHaveBean(DatumRequestMatchers.class).doesNotHaveBean(DatumSecurityResponses.class);
                assertThat(context).hasBean("datumSecurityStartupCheck");
            });
    }

    @Test
    void eachStackGetsItsMatchersHandlersAndCheck() {
        new WebApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumSecurityAutoConfiguration.class))
            .run(context -> {
                assertThat(context).hasSingleBean(DatumRequestMatchers.class).hasSingleBean(DatumSecurityResponses.class)
                    .doesNotHaveBean(DatumExchangeMatchers.class);
                assertThat(context.getBean("datumSecurityStartupCheck", DatumStartupCheck.class).check()).as("no open route").isEmpty();
            });
        new ReactiveWebApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumSecurityAutoConfiguration.class))
            .run(context -> assertThat(context).hasSingleBean(DatumExchangeMatchers.class).hasSingleBean(DatumServerSecurityResponses.class)
                .doesNotHaveBean(DatumRequestMatchers.class));
        new WebApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumSecurityAutoConfiguration.class))
            .withPropertyValues("datum.enabled=false")
            .run(context -> assertThat(context).doesNotHaveBean(DatumRequestMatchers.class).doesNotHaveBean("datumSecurityStartupCheck"));
    }

    @Test
    void theWarnFiresWhenAnOpenRouteHasNoChainOfTheStacksKind() {
        DefaultListableBeanFactory builder = routes("datumBuilderRoutes", "datumFormsRoutes");
        assertThat(DatumSecurityAutoConfiguration.facts(builder, new MockEnvironment(), SERVLET_CHAIN)).isEqualTo(new Facts(true, false, false, false));
        builder.registerSingleton("chain", new DefaultSecurityFilterChain(AnyRequestMatcher.INSTANCE));
        assertThat(DatumSecurityAutoConfiguration.facts(builder, new MockEnvironment(), SERVLET_CHAIN).chain()).isTrue();
        assertThat(DatumSecurityAutoConfiguration.facts(builder, new MockEnvironment(), REACTIVE_CHAIN).chain())
            .as("a servlet chain does not secure a reactive server").isFalse();

        DefaultListableBeanFactory passkeys = routes("datumWebAuthnRoutes");
        passkeys.registerSingleton("chain", new SecurityWebFilterChain() {
            @Override
            public Mono<Boolean> matches(org.springframework.web.server.ServerWebExchange exchange) {
                return Mono.just(true);
            }

            @Override
            public Flux<org.springframework.web.server.WebFilter> getWebFilters() {
                return Flux.empty();
            }
        });
        assertThat(DatumSecurityAutoConfiguration.facts(passkeys, new MockEnvironment(), REACTIVE_CHAIN)).isEqualTo(new Facts(false, true, false, true));
        assertThat(DatumSecurityAutoConfiguration.facts(passkeys, new MockEnvironment(), SERVLET_CHAIN).chain()).isFalse();

        DefaultListableBeanFactory proxied = routes("datumWebAuthnRoutes");
        proxied.registerSingleton("springSecurityWebFilterChainFilter", new WebFilterChainProxy(java.util.List.of()));
        assertThat(DatumSecurityAutoConfiguration.facts(proxied, new MockEnvironment(), DatumSecurityAutoConfiguration.REACTIVE_CHAINS).chain())
            .as("the WebFlux filter proxy carries Spring Security's default chain").isTrue();
        assertThat(DatumSecurityAutoConfiguration.facts(proxied, new MockEnvironment(), DatumSecurityAutoConfiguration.SERVLET_CHAINS).chain())
            .isFalse();
    }

    /**
     * What Spring Boot's reactive security auto-configuration applies when the application declares no chain:
     * {@code @EnableWebFluxSecurity} (with Boot's in-memory user), whose default chain (everything needs a sign-in)
     * is built inside the configuration, never as a {@code SecurityWebFilterChain} bean.
     */
    @Configuration(proxyBeanMethods = false)
    @EnableWebFluxSecurity
    static class SpringSecuritysDefaultWebFluxChain {

        @Bean
        MapReactiveUserDetailsService users() {
            return new MapReactiveUserDetailsService(User.withUsername("user").password("{noop}password").roles("USER").build());
        }
    }

    /** An open route for the WARN to judge: the passkey routes bean, by its name. */
    @Configuration(proxyBeanMethods = false)
    static class PasskeyRoutesOn {

        @Bean
        Object datumWebAuthnRoutes() {
            return new Object();
        }
    }

    @Test
    void springSecuritysDefaultWebFluxChainCountsAsAChain() {
        // The default WebFlux chain is no SecurityWebFilterChain bean, only the filter proxy.
        new ReactiveWebApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumSecurityAutoConfiguration.class))
            .withUserConfiguration(PasskeyRoutesOn.class, SpringSecuritysDefaultWebFluxChain.class)
            .run(context -> {
                assertThat(context).hasSingleBean(WebFilterChainProxy.class).doesNotHaveBean(SecurityWebFilterChain.class);
                assertThat(context.getBean("datumSecurityStartupCheck", DatumStartupCheck.class).check()).isEmpty();
            });
        new ReactiveWebApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumSecurityAutoConfiguration.class))
            .withUserConfiguration(PasskeyRoutesOn.class)
            .run(context -> assertThat(context.getBean("datumSecurityStartupCheck", DatumStartupCheck.class).check())
                .singleElement().satisfies(notice -> assertThat(notice.message())
                    .contains("no SecurityWebFilterChain")
                    .endsWith("these routes are open: add spring-boot-starter-security and secure DatumRequestMatchers "
                        + "(DatumExchangeMatchers on this stack) in your filter chain.")));
    }

    @Test
    void theTimestampServerCountsInClientModeOnly() {
        DefaultListableBeanFactory tsa = routes("datumTsaRoutes");
        assertThat(DatumSecurityAutoConfiguration.facts(tsa, new MockEnvironment(), SERVLET_CHAIN).tsaClientMode()).as("clients by default").isTrue();
        assertThat(DatumSecurityAutoConfiguration.facts(tsa, new MockEnvironment().withProperty("datum.tsa.access", "clients"), SERVLET_CHAIN)
            .tsaClientMode()).isTrue();
        assertThat(DatumSecurityAutoConfiguration.facts(tsa, new MockEnvironment().withProperty("datum.tsa.access", "OPEN"), SERVLET_CHAIN)
            .tsaClientMode()).isFalse();
        assertThat(DatumSecurityAutoConfiguration.facts(routes(), new MockEnvironment(), SERVLET_CHAIN)).isEqualTo(new Facts(false, false, false, false));
    }

    /**
     * The WARN judges the timestamp server's access as its binding mapped it (the {@code DatumRouteBase} it contributes, from
     * the overridable {@code TsaSettings} bean), not {@code datum.tsa.access}: an application's
     * settings bean in client mode with the property saying open needs a chain and is warned about, and the reverse is not.
     */
    @Test
    void theTimestampServersAccessIsTheBindingsNotTheProperty() {
        DefaultListableBeanFactory clients = routes("datumTsaRoutes");
        clients.registerSingleton("datumTsaRouteBase", new DatumRouteBase(Base.TSA, "/tsa", false));
        assertThat(DatumSecurityAutoConfiguration.facts(clients, new MockEnvironment().withProperty("datum.tsa.access", "open"), SERVLET_CHAIN)
            .tsaClientMode()).as("the settings bean's clients, not the property's open").isTrue();
        DefaultListableBeanFactory open = routes("datumTsaRoutes");
        open.registerSingleton("datumTsaRouteBase", new DatumRouteBase(Base.TSA, "/tsa", true));
        assertThat(DatumSecurityAutoConfiguration.facts(open, new MockEnvironment().withProperty("datum.tsa.access", "clients"), SERVLET_CHAIN)
            .tsaClientMode()).as("the settings bean's open, not the property's clients").isFalse();
        DefaultListableBeanFactory passkeysOnly = routes("datumTsaRoutes");
        passkeysOnly.registerSingleton("datumWebAuthnRouteBase", new DatumRouteBase(Base.WEBAUTHN, "/keys"));
        assertThat(DatumSecurityAutoConfiguration.facts(passkeysOnly, new MockEnvironment().withProperty("datum.tsa.access", "open"), SERVLET_CHAIN)
            .tsaClientMode()).as("no TSA contribution: the property is used").isFalse();
        assertThat(new DatumRouteBase(Base.WEBAUTHN, "/keys").open()).as("a route base needs securing unless its binding says otherwise").isFalse();
    }

    // ------------------------------------------------------------------------------------------ helpers

    private static MockHttpServletRequest post(String path) {
        return new MockHttpServletRequest("POST", path);
    }

    private static boolean matches(org.springframework.security.web.server.util.matcher.ServerWebExchangeMatcher matcher, String path) {
        return matcher.matches(MockServerWebExchange.from(MockServerHttpRequest.post(path))).block().isMatch();
    }

    /**
     * The TSA and passkey matchers follow the bases the capability bindings mapped (their {@code DatumRouteBase} beans, built
     * from the overridable settings beans), not {@code datum.tsa.path} and {@code datum.webauthn.path}: an application's
     * settings bean with another path would otherwise leave its rule on the stale path and the routes open to {@code anyRequest()}.
     */
    @Test
    void theMatchersFollowTheBasesTheBindingsMappedNotTheProperties() {
        String[] properties = {"datum.tsa.path=/property-tsa", "datum.webauthn.path=/property-keys"};
        new WebApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumSecurityAutoConfiguration.class))
            .withPropertyValues(properties)
            .withBean("tsaBase", DatumRouteBase.class, () -> new DatumRouteBase(Base.TSA, "/stamps"))
            .withBean("passkeysBase", DatumRouteBase.class, () -> new DatumRouteBase(Base.WEBAUTHN, "/keys"))
            .run(context -> {
                assertThat(context).hasNotFailed();
                DatumRequestMatchers datum = context.getBean(DatumRequestMatchers.class);
                assertThat(datum.tsa().matches(post("/stamps"))).isTrue();
                assertThat(datum.tsa().matches(post("/property-tsa"))).as("the property is not where the routes are").isFalse();
                assertThat(datum.passkeys().matches(post("/keys/challenge"))).isTrue();
                assertThat(datum.passkeys().matches(post("/property-keys/challenge"))).isFalse();
                assertThat(datum.all().matches(post("/keys/register"))).isTrue();
            });
        new ReactiveWebApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumSecurityAutoConfiguration.class))
            .withPropertyValues(properties)
            .withBean("tsaBase", DatumRouteBase.class, () -> new DatumRouteBase(Base.TSA, "/stamps"))
            .withBean("passkeysBase", DatumRouteBase.class, () -> new DatumRouteBase(Base.WEBAUTHN, "/keys"))
            .run(context -> {
                assertThat(context).hasNotFailed();
                DatumExchangeMatchers datum = context.getBean(DatumExchangeMatchers.class);
                assertThat(matches(datum.tsa(), "/stamps")).isTrue();
                assertThat(matches(datum.tsa(), "/property-tsa")).isFalse();
                assertThat(matches(datum.passkeys(), "/keys/challenge")).isTrue();
                assertThat(matches(datum.passkeys(), "/property-keys/challenge")).isFalse();
            });
    }

    /** A capability that is off or absent contributes no base: the property is read. */
    @Test
    void withoutABindingsBaseThePropertyIsRead() {
        new WebApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumSecurityAutoConfiguration.class))
            .withPropertyValues("datum.tsa.path=/property-tsa")
            .run(context -> {
                DatumRequestMatchers datum = context.getBean(DatumRequestMatchers.class);
                assertThat(datum.tsa().matches(post("/property-tsa"))).isTrue();
                assertThat(datum.passkeys().matches(post("/api/webauthn/challenge"))).as("the default").isTrue();
            });
    }

    /** Two beans naming one base are a configuration the matchers cannot follow: the start says so instead of picking one. */
    @Test
    void twoBasesForOneCapabilityStopTheStart() {
        new WebApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumSecurityAutoConfiguration.class))
            .withBean("one", DatumRouteBase.class, () -> new DatumRouteBase(Base.TSA, "/one"))
            .withBean("two", DatumRouteBase.class, () -> new DatumRouteBase(Base.TSA, "/two"))
            .run(context -> assertThat(context).hasFailed().getFailure().rootCause().hasMessageContaining("TSA"));
        new WebApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(DatumWebAutoConfiguration.class, DatumSecurityAutoConfiguration.class))
            .withBean("api", DatumRouteBase.class, () -> new DatumRouteBase(Base.API, "/elsewhere"))
            .run(context -> assertThat(context).hasFailed().getFailure().rootCause().hasMessageContaining("WebSettings"));
    }
}
