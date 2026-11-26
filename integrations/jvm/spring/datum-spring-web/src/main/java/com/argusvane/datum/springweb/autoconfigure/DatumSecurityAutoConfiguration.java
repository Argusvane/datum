package com.argusvane.datum.springweb.autoconfigure;

import com.argusvane.datum.core.DatumStartupCheck;
import com.argusvane.datum.springweb.mvc.DatumRequestMatchers;
import com.argusvane.datum.springweb.mvc.DatumSecurityResponses;
import com.argusvane.datum.springweb.spring.DatumRouteBase;
import com.argusvane.datum.springweb.webflux.DatumExchangeMatchers;
import com.argusvane.datum.springweb.webflux.DatumServerSecurityResponses;
import com.argusvane.datum.web.WebSettings;
import com.argusvane.datum.web.error.ErrorMapper;
import com.argusvane.datum.web.json.DatumJsonMapper;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog.Base;
import com.argusvane.datum.web.security.SecurityStartupCheck;
import com.argusvane.datum.web.security.SecurityStartupCheck.Facts;
import java.util.EnumMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.springframework.beans.factory.ListableBeanFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication.Type;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.util.ClassUtils;

/**
 * Access is the application's security (framework-first): Datum
 * asks no access policy, and this configuration gives the application what Spring Security needs to secure Datum's
 * routes the standard way. With Spring Security on the classpath: the request matchers per capability
 * ({@link DatumRequestMatchers} on a servlet stack, {@link DatumExchangeMatchers} on WebFlux) built from the
 * paths the routes are mapped under (the settings beans', through {@link DatumRouteBase}), and the JSON 401/403 handlers ({@link DatumSecurityResponses}, {@link DatumServerSecurityResponses})
 * the application installs in its chain. Always, on a web application: the start-up WARN when routes that need
 * securing are on and no chain exists ({@link SecurityStartupCheck}, whose facts are gathered here: the capability
 * route beans, the timestamp server's access (its binding's {@link DatumRouteBase}, else {@code datum.tsa.access}), and
 * a chain of the stack's type). Nothing here secures a route by itself.
 *
 * <p>A chain is a chain bean of the stack's type or Spring Security's filter proxy for the stack. The proxy is the
 * one that counts on WebFlux: Spring Security builds its default chain there (everything needs a sign-in) inside
 * {@code WebFluxSecurityConfiguration}, never as a {@code SecurityWebFilterChain} bean, and Spring Boot adds such a
 * bean only with Actuator, so an application with spring-boot-starter-security and no chain of its own would
 * otherwise be told to add the dependency it has. On a servlet stack Spring Boot's default chain is a bean; the proxy
 * counts there too, for an application that enables web security without Boot's auto-configuration.
 */
@AutoConfiguration(after = DatumWebAutoConfiguration.class)
@ConditionalOnProperty(prefix = "datum", name = "enabled", matchIfMissing = true)
@ConditionalOnWebApplication
public final class DatumSecurityAutoConfiguration {

    /**
     * The bases the routes are mapped under, as each capability normalises them (DatumRouteGroups.basePath). The API base
     * is the {@link WebSettings} bean's; the TSA and passkey bases are the ones their bindings mapped, from the
     * {@link DatumRouteBase} beans those bindings contribute out of their (overridable) settings beans.
     * A capability that is off or absent contributes none, and its property is read, so a matcher still names
     * the configured path. Two contributions for one base stop the start: a security matcher must not guess.
     */
    static Map<Base, String> bases(WebSettings settings, List<DatumRouteBase> contributed, Environment environment) {
        Map<Base, String> bases = new EnumMap<>(Base.class);
        bases.put(Base.API, settings.api().path());
        bases.put(Base.TSA, environment.getProperty("datum.tsa.path"));
        bases.put(Base.WEBAUTHN, environment.getProperty("datum.webauthn.path"));
        Map<Base, String> mapped = new EnumMap<>(Base.class);
        for (DatumRouteBase base : contributed) {
            if (base.base() == Base.API) {
                throw new IllegalStateException("A DatumRouteBase bean names the API base (" + base.path() + "): the API base is the WebSettings "
                    + "bean's (datum.web.api.path); a DatumRouteBase names the TSA or the WebAuthn base.");
            }
            String before = mapped.putIfAbsent(base.base(), base.path());
            if (before != null) {
                throw new IllegalStateException("Two DatumRouteBase beans name the " + base.base() + " base (" + before + " and " + base.path()
                    + "): the security matchers cannot tell which routes are mapped. Keep the one the capability's binding contributes.");
            }
        }
        bases.putAll(mapped);
        return bases;
    }

    /**
     * What the WARN judges, read once every bean exists: each capability's routes bean exists only when its switch
     * turned it on and its module is present, so a switch for an absent module warns about nothing. The timestamp
     * server's access is the one its binding contributed with its {@link DatumRouteBase} (from the overridable
     * {@code TsaSettings} bean); {@code datum.tsa.access} is read only without one.
     */
    static Facts facts(ListableBeanFactory beans, Environment environment, String... chainTypes) {
        Boolean tsaOpen = null;
        for (DatumRouteBase base : beans.getBeansOfType(DatumRouteBase.class, true, false).values()) {
            if (base.base() == Base.TSA) {
                tsaOpen = base.open();
            }
        }
        if (tsaOpen == null) {
            tsaOpen = "open".equals(environment.getProperty("datum.tsa.access", "clients").strip().toLowerCase(Locale.ROOT));
        }
        boolean tsaClients = beans.containsBean("datumTsaRoutes") && !tsaOpen;
        ClassLoader loader = DatumSecurityAutoConfiguration.class.getClassLoader();
        boolean chain = false;
        for (String chainType : chainTypes) {
            chain |= ClassUtils.isPresent(chainType, loader)
                && beans.getBeanNamesForType(ClassUtils.resolveClassName(chainType, loader), true, false).length > 0;
        }
        return new Facts(beans.containsBean("datumBuilderRoutes"), beans.containsBean("datumWebAuthnRoutes"), tsaClients, chain);
    }

    /** The servlet stack's chain bean type and Spring Security's filter proxy. */
    static final String[] SERVLET_CHAINS = {"org.springframework.security.web.SecurityFilterChain",
        "org.springframework.security.web.FilterChainProxy"};

    /** The reactive stack's chain bean type and Spring Security's WebFlux filter proxy (its default chain). */
    static final String[] REACTIVE_CHAINS = {"org.springframework.security.web.server.SecurityWebFilterChain",
        "org.springframework.security.web.server.WebFilterChainProxy"};

    /** The remedy in Spring's terms (the line's shape is web-core's, so a Quarkus binding would word its own). */
    static String remedy(String matchers) {
        return "add spring-boot-starter-security and secure DatumRequestMatchers"
            + ("DatumRequestMatchers".equals(matchers) ? "" : " (" + matchers + " on this stack)") + " in your filter chain";
    }

    /** A servlet application: the WARN, and with Spring Security the matchers and the handlers. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.SERVLET)
    static class Servlet {

        @Bean
        DatumStartupCheck datumSecurityStartupCheck(ListableBeanFactory beans, Environment environment) {
            return SecurityStartupCheck.check(() -> facts(beans, environment, SERVLET_CHAINS),
                "SecurityFilterChain", "DatumRequestMatchers", remedy("DatumRequestMatchers"));
        }

        @Configuration(proxyBeanMethods = false)
        @ConditionalOnClass(name = {"org.springframework.security.web.servlet.util.matcher.PathPatternRequestMatcher",
            "jakarta.servlet.http.HttpServletRequest"})
        static class WithSecurity {

            @Bean
            @ConditionalOnMissingBean
            DatumRequestMatchers datumRequestMatchers(WebSettings settings, ObjectProvider<DatumRouteBase> bases, Environment environment) {
                return new DatumRequestMatchers(bases(settings, bases.orderedStream().toList(), environment), settings.assets().path());
            }

            @Bean
            @ConditionalOnMissingBean
            DatumSecurityResponses datumSecurityResponses(ErrorMapper errors, DatumJsonMapper json, WebSettings settings) {
                return new DatumSecurityResponses(errors, json, settings.csrf());
            }
        }
    }

    /** A reactive application: the WARN, and with Spring Security the matchers and the handlers. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.REACTIVE)
    static class Reactive {

        @Bean
        DatumStartupCheck datumSecurityStartupCheck(ListableBeanFactory beans, Environment environment) {
            return SecurityStartupCheck.check(() -> facts(beans, environment, REACTIVE_CHAINS),
                "SecurityWebFilterChain", "DatumExchangeMatchers", remedy("DatumExchangeMatchers"));
        }

        @Configuration(proxyBeanMethods = false)
        @ConditionalOnClass(name = {"org.springframework.security.web.server.util.matcher.PathPatternParserServerWebExchangeMatcher",
            "org.springframework.web.server.ServerWebExchange"})
        static class WithSecurity {

            @Bean
            @ConditionalOnMissingBean
            DatumExchangeMatchers datumExchangeMatchers(WebSettings settings, ObjectProvider<DatumRouteBase> bases, Environment environment) {
                return new DatumExchangeMatchers(bases(settings, bases.orderedStream().toList(), environment), settings.assets().path());
            }

            @Bean
            @ConditionalOnMissingBean
            DatumServerSecurityResponses datumServerSecurityResponses(ErrorMapper errors, DatumJsonMapper json, WebSettings settings) {
                return new DatumServerSecurityResponses(errors, json, settings.csrf());
            }
        }
    }
}
