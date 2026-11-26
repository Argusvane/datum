package com.argusvane.datum.webauthn.spring;

import com.argusvane.datum.core.DatumEventPublisher;
import com.argusvane.datum.springweb.spring.DatumRouteBase;
import com.argusvane.datum.springweb.spring.SpringEventPublisher;
import com.argusvane.datum.springweb.webflux.DatumMethodRules;
import com.argusvane.datum.springweb.webflux.DatumRouteRegistry;
import com.argusvane.datum.web.json.DatumJsonMapper;
import com.argusvane.datum.web.openapi.DatumEndpointCatalog;
import com.argusvane.datum.webauthn.FormSigningSource;
import com.argusvane.datum.webauthn.PasskeyChallenges;
import com.argusvane.datum.webauthn.PasskeyRepository;
import com.argusvane.datum.webauthn.PasskeySubjectResolver;
import com.argusvane.datum.webauthn.PasskeyUseStore;
import com.argusvane.datum.webauthn.RegistrationCeremony;
import com.argusvane.datum.webauthn.WebAuthnSettings;
import com.argusvane.datum.webauthn.WebAuthnVerifier;
import com.argusvane.datum.webauthn.web.PasskeyTesters;
import com.argusvane.datum.webauthn.web.PasskeyThrottle;
import com.argusvane.datum.webauthn.web.PasskeysApi;
import com.argusvane.datum.webauthn.web.PasskeysRoutes;
import com.argusvane.datum.webauthn.web.mvc.PasskeysMvcController;
import com.argusvane.datum.webauthn.web.webflux.PasskeysWebFluxHandlers;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.enums.ParameterIn;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.parameters.RequestBody;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import java.time.Clock;
import org.springdoc.core.annotations.RouterOperation;
import org.springdoc.core.annotations.RouterOperations;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication.Type;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.ApplicationContext;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;
import com.argusvane.datum.webauthn.PasskeySettings;

/**
 * The passkey endpoints on whichever web stack the application runs: an MVC {@code @RestController} marked
 * {@code @DatumController}, or a WebFlux router function whose paths are registered with
 * {@link DatumRouteRegistry} (so only these paths, never the application's own routes, get Datum's error
 * answers). Both call the one {@link PasskeysApi}. Present only with {@code datum.webauthn.enabled=true}; switched
 * off, the paths are the application's own (404).
 *
 * <p>The nested stack configurations follow {@code DatumFormsWebAutoConfiguration}: an MVC application never
 * loads a WebFlux class and the reverse.
 */
@AutoConfiguration(after = DatumWebAuthnAutoConfiguration.class)
@ConditionalOnProperty(prefix = "datum", name = "enabled", matchIfMissing = true)
@ConditionalOnProperty(prefix = "datum.webauthn", name = "enabled", havingValue = "true")
@ConditionalOnWebApplication
public final class DatumWebAuthnWebAutoConfiguration {

    @Bean(name = PasskeysRoutes.BEAN_NAME)
    PasskeysRoutes datumWebAuthnRoutes(PasskeySettings settings) {
        return new PasskeysRoutes(settings);
    }

    /**
     * The base the routes are mapped under, for datum-spring-web's security matchers: from the routes bean, so
     * an application's own {@link PasskeySettings} bean with another path moves {@code datum.passkeys()} with the routes rather
     * than leaving the application's rule on {@code datum.webauthn.path}.
     */
    @Bean
    DatumRouteBase datumWebAuthnRouteBase(PasskeysRoutes routes) {
        return new DatumRouteBase(DatumEndpointCatalog.Base.WEBAUTHN, routes.path());
    }

    /**
     * The endpoints. {@code registerAtSubmit} and {@code labelPath} come from the {@link PasskeySettings} bean, so
     * an application's own settings bean (a tenant store, say) that turns registration at submit off is obeyed; reading the
     * properties instead let visitors keep registering. Who may use the Test context stays a binding property
     * ({@code datum.webauthn.test-roles}, read with Spring Security's role prefix).
     */
    @Bean
    @ConditionalOnMissingBean
    PasskeysApi datumPasskeysApi(WebAuthnSettings settings, PasskeySettings passkeySettings,
                                 RegistrationCeremony ceremony, PasskeyChallenges challenges, PasskeyRepository passkeys, PasskeyUseStore uses,
                                 WebAuthnVerifier verifier, FormSigningSource forms, PasskeySubjectResolver subjects, PasskeyThrottle throttle,
                                 DatumJsonMapper json, ObjectProvider<DatumEventPublisher> publisher, ApplicationEventPublisher events,
                                 ObjectProvider<Clock> clock, PasskeyTesters testers) {
        PasskeysApi.Options options = new PasskeysApi.Options(passkeySettings.registerAtSubmit(), passkeySettings.labelPath(), testers);
        return new PasskeysApi(settings, options, ceremony, challenges, passkeys, uses, verifier, forms, subjects, throttle, json,
            SpringEventPublisher.of(publisher, events), clock.getIfAvailable(Clock::systemUTC));
    }

    /**
     * Who may use a form's Test context, a bean so an application with another rule declares one of its own instead of the
     * 13-argument {@link PasskeysApi}. The default is the exact match on
     * {@code datum.webauthn.test-roles} under the application's role prefix: no role hierarchy is followed, because this
     * check gates who may make test passkeys and a hierarchy would admit more principals than the roles named. Never published when the application defines its own.
     */
    @Bean
    @ConditionalOnMissingBean
    PasskeyTesters datumPasskeyTesters(DatumWebAuthnProperties properties, ApplicationContext context) {
        java.util.function.Predicate<java.security.Principal> rule = testers(properties, rolePrefix(context));
        return rule::test;
    }

    /**
     * The purge of anonymous passkeys on a timer (framework-first: Spring's {@link TaskScheduler}). Spring Boot creates
     * a scheduler only when {@code @EnableScheduling} is present (or the application defines one), so without one, or
     * with two and none primary, this bean does nothing and the purge that runs when an anonymous visitor registers
     * stays the fallback.
     */
    @Bean
    PasskeyPurgeSchedule datumPasskeyPurgeSchedule(PasskeysApi api, ObjectProvider<TaskScheduler> scheduler) {
        return new PasskeyPurgeSchedule(api::purgeAnonymous, scheduler.getIfUnique());
    }

    /**
     * Who may use a form's Test context: the roles of {@code datum.webauthn.test-roles} on the Spring
     * Security authentication, nobody when none is named. Without Spring Security there is no role to read, so a
     * named role is a configuration that cannot work: the start says so and nobody may.
     */
    static java.util.function.Predicate<java.security.Principal> testers(DatumWebAuthnProperties properties) {
        return testers(properties, "ROLE_");
    }

    /**
     * The role prefix the application chose with a {@code GrantedAuthorityDefaults} bean, else Spring Security's
     * {@code ROLE_}. The class lives in spring-security-config, so it is only touched when present.
     */
    static String rolePrefix(ApplicationContext context) {
        if (!org.springframework.util.ClassUtils.isPresent("org.springframework.security.config.core.GrantedAuthorityDefaults",
            DatumWebAuthnWebAutoConfiguration.class.getClassLoader())) {
            return "ROLE_";
        }
        return AuthorityDefaults.prefix(context);
    }

    /** Loaded only when spring-security-config is on the class path. */
    private static final class AuthorityDefaults {

        static String prefix(ApplicationContext context) {
            org.springframework.security.config.core.GrantedAuthorityDefaults defaults =
                context.getBeanProvider(org.springframework.security.config.core.GrantedAuthorityDefaults.class).getIfUnique();
            return defaults == null ? "ROLE_" : defaults.getRolePrefix();
        }
    }

    static java.util.function.Predicate<java.security.Principal> testers(DatumWebAuthnProperties properties, String rolePrefix) {
        if (properties.getTestRoles().stream().allMatch(role -> role == null || role.isBlank())) {
            return PasskeysApi.Options.NOBODY;
        }
        if (!org.springframework.util.ClassUtils.isPresent("org.springframework.security.core.Authentication",
            DatumWebAuthnWebAutoConfiguration.class.getClassLoader())) {
            org.slf4j.LoggerFactory.getLogger("datum.webauthn").warn("datum.webauthn.test-roles names roles, but Spring Security is not on the "
                + "classpath to read them: nobody may make a passkey in the Test context.");
            return PasskeysApi.Options.NOBODY;
        }
        return new SecurityRoleTesters(properties.getTestRoles(), rolePrefix);
    }

    /** Spring MVC: the controller. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.SERVLET)
    @ConditionalOnClass(name = "org.springframework.web.servlet.DispatcherServlet")
    static class Mvc {

        @Bean
        PasskeysMvcController datumPasskeysController(PasskeysApi api) {
            return new PasskeysMvcController(api);
        }
    }

    /** WebFlux: one router function. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.REACTIVE)
    @ConditionalOnClass(name = "org.springframework.web.reactive.config.WebFluxConfigurer")
    static class Reactive {

        // Springdoc reads annotation values literally (it does not resolve placeholders in a router operation's
        // path), so the operations are annotated at the default path; DatumWebAuthnOpenApiAutoConfiguration moves
        // the document's path keys to the configured datum.webauthn.path.
        private static final String PATH = "/api/webauthn";
        private static final String ERRORS = "#/components/schemas/ErrorsBody";
        private static final String JSON = "application/json";

        /** A bean, because springdoc looks the handler class up in the context to read the operation's method. */
        @Bean
        PasskeysWebFluxHandlers datumPasskeysHandlers(PasskeysApi api, ObjectProvider<Scheduler> scheduler) {
            return new PasskeysWebFluxHandlers(api, scheduler.getIfUnique(Schedulers::boundedElastic));
        }

        @Bean
        @RouterOperations({
            @RouterOperation(path = PATH + "/challenge", method = RequestMethod.POST,
                beanClass = PasskeysWebFluxHandlers.class, beanMethod = "challenge",
                operation = @Operation(operationId = "passkeyChallenge", summary = "A passkey registration challenge", tags = "datum-webauthn",
                    description = "{context: submit|amend|test, form?, label?}. With a form key: a passkey made at that form (the form must sign); without: "
                        + "a passkey a signed-in person adds ahead of time. The answer is what the engine's registerCredential() reads.",
                    requestBody = @RequestBody(required = true, content = @Content(mediaType = JSON, schema = @Schema(type = "object"))),
                    responses = {
                        @ApiResponse(responseCode = "200", description = "The options.", content = @Content(mediaType = JSON, schema = @Schema(type = "object"))),
                        @ApiResponse(responseCode = "403", description = "Refused (signing.sign_in, signing.context, signing.register_off; access.denied by the application's security with DatumSecurityResponses).",
                            content = @Content(mediaType = JSON, schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "404", description = "No such form, or it does not sign (signing.off).",
                            content = @Content(mediaType = JSON, schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "429", description = "Too many requests (flood).", content = @Content(mediaType = JSON, schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "503", description = "Passkeys are not set up (signing.not_set_up).",
                            content = @Content(mediaType = JSON, schema = @Schema(ref = ERRORS)))})),
            @RouterOperation(path = PATH + "/register", method = RequestMethod.POST,
                beanClass = PasskeysWebFluxHandlers.class, beanMethod = "register",
                operation = @Operation(operationId = "passkeyRegister", summary = "Verify and store a passkey the browser created", tags = "datum-webauthn",
                    description = "{token, label?, context, form?, credential: {id, publicKey, algorithm, transports, userHandle, response}}: what the engine's "
                        + "registerCredential() returned. Answers 201 with {id, transports, algorithm, publicKey, label, createdAt}.",
                    requestBody = @RequestBody(required = true, content = @Content(mediaType = JSON, schema = @Schema(type = "object"))),
                    responses = {
                        @ApiResponse(responseCode = "201", description = "The stored passkey.", content = @Content(mediaType = JSON, schema = @Schema(type = "object"))),
                        @ApiResponse(responseCode = "400", description = "The body could not be read, or the challenge expired or was used (passkey.bad_request, passkey.challenge).",
                            content = @Content(mediaType = JSON, schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "403", description = "Refused (signing.*; access.denied by the application's security with DatumSecurityResponses).", content = @Content(mediaType = JSON, schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "404", description = "No such form, or it does not sign.", content = @Content(mediaType = JSON, schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "409", description = "Registered already (passkey.exists).", content = @Content(mediaType = JSON, schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "422", description = "A WebAuthn check failed (passkey.invalid).", content = @Content(mediaType = JSON, schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "429", description = "Too many requests (flood).", content = @Content(mediaType = JSON, schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "503", description = "Passkeys are not set up (signing.not_set_up).", content = @Content(mediaType = JSON, schema = @Schema(ref = ERRORS)))})),
            @RouterOperation(path = PATH + "/passkeys", method = RequestMethod.GET,
                beanClass = PasskeysWebFluxHandlers.class, beanMethod = "mine",
                operation = @Operation(operationId = "listPasskeys", summary = "The caller's passkeys", tags = "datum-webauthn",
                    description = "With form: the passkeys the page offers the browser, and a signing block of what the page needs. Without: the caller's list. "
                        + "An anonymous caller has none.",
                    parameters = @Parameter(name = "form", in = ParameterIn.QUERY, description = "A form key.", schema = @Schema(type = "string")),
                    responses = {
                        @ApiResponse(responseCode = "200", description = "{passkeys: [...], signing?}.", content = @Content(mediaType = JSON, schema = @Schema(type = "object"))),
                        @ApiResponse(responseCode = "403", description = "Refused by the application's security (access.denied when it installs DatumSecurityResponses).", content = @Content(mediaType = JSON, schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "404", description = "No such form, or it does not sign.", content = @Content(mediaType = JSON, schema = @Schema(ref = ERRORS)))})),
            @RouterOperation(path = PATH + "/passkeys/{id}", method = RequestMethod.DELETE,
                beanClass = PasskeysWebFluxHandlers.class, beanMethod = "remove",
                operation = @Operation(operationId = "removePasskey", summary = "Revoke and remove a passkey", tags = "datum-webauthn",
                    description = "The owner removes a passkey by its credential id. It is revoked, then deleted unless a stored "
                        + "submission names it (then it is kept, its label cleared).",
                    parameters = @Parameter(name = "id", in = ParameterIn.PATH, required = true, description = "The credential id.", schema = @Schema(type = "string")),
                    responses = {
                        @ApiResponse(responseCode = "200", description = "{id, status: deleted|removed}.", content = @Content(mediaType = JSON, schema = @Schema(type = "object"))),
                        @ApiResponse(responseCode = "404", description = "No such passkey (passkey.notFound), or not the caller's.",
                            content = @Content(mediaType = JSON, schema = @Schema(ref = ERRORS)))})),
            @RouterOperation(path = PATH + "/passkeys/{id}/check-challenge", method = RequestMethod.POST,
                beanClass = PasskeysWebFluxHandlers.class, beanMethod = "checkChallenge",
                operation = @Operation(operationId = "passkeyCheckChallenge", summary = "A challenge to test one of the caller's passkeys", tags = "datum-webauthn",
                    description = "Answers {challenge, token, expires, rpId, allowCredentials, userVerification} for a get() ceremony. Nothing is signed.",
                    parameters = @Parameter(name = "id", in = ParameterIn.PATH, required = true, description = "The credential id.", schema = @Schema(type = "string")),
                    responses = {
                        @ApiResponse(responseCode = "200", description = "The options.", content = @Content(mediaType = JSON, schema = @Schema(type = "object"))),
                        @ApiResponse(responseCode = "404", description = "No such passkey of the caller's.", content = @Content(mediaType = JSON, schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "409", description = "The passkey was revoked (passkey.revoked).", content = @Content(mediaType = JSON, schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "429", description = "Too many requests (flood).", content = @Content(mediaType = JSON, schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "503", description = "Passkeys are not set up (signing.not_set_up).", content = @Content(mediaType = JSON, schema = @Schema(ref = ERRORS)))})),
            @RouterOperation(path = PATH + "/passkeys/{id}/check", method = RequestMethod.POST,
                beanClass = PasskeysWebFluxHandlers.class, beanMethod = "check",
                operation = @Operation(operationId = "passkeyCheck", summary = "Check the assertion a passkey test made", tags = "datum-webauthn",
                    description = "{token, assertion}. 200 {ok, lastUsed}; 422 passkey.check when it does not verify, passkey.counter when the counter did not go up.",
                    parameters = @Parameter(name = "id", in = ParameterIn.PATH, required = true, description = "The credential id.", schema = @Schema(type = "string")),
                    requestBody = @RequestBody(required = true, content = @Content(mediaType = JSON, schema = @Schema(type = "object"))),
                    responses = {
                        @ApiResponse(responseCode = "200", description = "It verifies.", content = @Content(mediaType = JSON, schema = @Schema(type = "object"))),
                        @ApiResponse(responseCode = "400", description = "The body could not be read, or the challenge expired or was used.", content = @Content(mediaType = JSON, schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "404", description = "No such passkey of the caller's.", content = @Content(mediaType = JSON, schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "409", description = "The passkey was revoked.", content = @Content(mediaType = JSON, schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "422", description = "It does not verify, or the counter did not go up.", content = @Content(mediaType = JSON, schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "503", description = "Passkeys are not set up (signing.not_set_up).", content = @Content(mediaType = JSON, schema = @Schema(ref = ERRORS)))}))})
        RouterFunction<ServerResponse> datumPasskeysRouterFunction(PasskeysRoutes routes, PasskeysWebFluxHandlers handlers, DatumRouteRegistry registry,
                                                                   DatumMethodRules methods) {
            registry.register(routes.routes().toArray(String[]::new));
            RouterFunctions.Builder router = RouterFunctions.route()
                .POST(routes.challengePath(), handlers::challenge)
                .POST(routes.registerPath(), handlers::register)
                // HEAD as GET, as MVC serves it and the Allow header has always named it.
                .GET(routes.listPath(), handlers::mine).HEAD(routes.listPath(), handlers::mine)
                .DELETE(routes.onePath(), handlers::remove)
                .POST(routes.checkChallengePath(), handlers::checkChallenge)
                .POST(routes.checkPath(), handlers::check);
            // A wrong method answers 405 as MVC does, from the shared method rules (DatumMethodNotAllowedMapping in
            // datum-spring-web, asked only when no controller and no router claimed the request): not a path-wide
            // route here, which would take the path from an application's own controller or router on it and write
            // the 405 itself (forms and the builder work the same way).
            methods.allow(routes.challengePath(), "POST");
            methods.allow(routes.registerPath(), "POST");
            methods.allow(routes.listPath(), "GET", "HEAD");
            methods.allow(routes.onePath(), "DELETE");
            methods.allow(routes.checkChallengePath(), "POST");
            methods.allow(routes.checkPath(), "POST");
            return router.build();
        }
    }
}
