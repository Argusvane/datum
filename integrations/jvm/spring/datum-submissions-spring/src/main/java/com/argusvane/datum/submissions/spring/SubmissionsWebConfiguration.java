package com.argusvane.datum.submissions.spring;

import com.argusvane.datum.sandbox.protocol.Sandbox;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.web.WebSettings;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import com.argusvane.datum.springweb.spring.DatumProperties;
import com.argusvane.datum.submissions.receiver.SubmissionReceiver;
import com.argusvane.datum.sandbox.runtime.DatumSandbox;
import com.argusvane.datum.submissions.web.SubmissionsApi;
import com.argusvane.datum.submissions.web.SubmissionsRoutes;
import com.argusvane.datum.submissions.web.mvc.InspectMvcController;
import com.argusvane.datum.submissions.web.mvc.SubmitMvcController;
import com.argusvane.datum.submissions.web.mvc.TestMvcController;
import com.argusvane.datum.submissions.web.mvc.ValidateMvcController;
import com.argusvane.datum.submissions.web.webflux.SubmissionsWebFluxHandlers;
import com.argusvane.datum.springweb.webflux.DatumMethodRules;
import com.argusvane.datum.springweb.webflux.DatumRouteRegistry;
import com.argusvane.datum.web.json.DatumJsonMapper;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.parameters.RequestBody;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import org.springdoc.core.annotations.RouterOperation;
import org.springdoc.core.annotations.RouterOperations;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication.Type;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Qualifier;

/**
 * The submissions endpoints on whichever web stack the application runs, imported by
 * {@code DatumSubmissionsAutoConfiguration}: MVC {@code @RestController}s marked {@code @DatumController}, or a
 * WebFlux router function whose paths are registered with {@link DatumRouteRegistry} (so only these paths,
 * never the application's own routes, get Datum's error answers). Both call the one {@link SubmissionsApi}.
 * Each endpoint is mapped only when its switch ({@code datum.web.api.endpoints.*}) is on, so a switched-off
 * route is simply absent: 404, and free for the application to map itself.
 *
 * <p>The nested stack configurations follow {@code DatumFormsWebAutoConfiguration}: an MVC application never
 * loads a WebFlux class and the reverse.
 */
@Configuration(proxyBeanMethods = false)
@ConditionalOnWebApplication
final class SubmissionsWebConfiguration {

    @Bean(name = SubmissionsRoutes.BEAN_NAME)
    SubmissionsRoutes datumSubmissionsRoutes(ObjectProvider<WebSettings> settings, ObjectProvider<DatumProperties> properties) {
        return new SubmissionsRoutes(settings.getIfAvailable(() -> properties.getObject().toSettings()));
    }

    @Bean
    @ConditionalOnMissingBean
    SubmissionsApi datumSubmissionsApi(SubmissionReceiver receiver, DatumSandbox runtime,
                                       ObjectProvider<Sandbox> sandbox,
                                       DefinitionService definitions, DatumJsonMapper json, com.argusvane.datum.sandbox.protocol.ProgramLimits limits) {
        // The inspection runs on the Sandbox bean, asked on every call, as the receiver and the definition service do:
        // the runtime's, or the application's replacement, which the binding has wrapped in the same decorators.
        return new SubmissionsApi(receiver, DatumSubmissionsAutoConfiguration.sandboxOf(sandbox, runtime), definitions, json, limits.maxBodyBytes());
    }

    /** Spring MVC: controllers, one bean per switch. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.SERVLET)
    @ConditionalOnClass(name = "org.springframework.web.servlet.DispatcherServlet")
    static class Mvc {

        /**
         * Lets an application controller take a {@code SubmissionRequest} parameter: the same view the Datum
         * controllers build, resolved by the one {@code SubmissionRequestResolver}. Added to the application's
         * resolvers, never in place of any.
         */
        @Bean
        @ConditionalOnMissingBean(name = "datumSubmissionRequestArgumentResolver")
        org.springframework.web.servlet.config.annotation.WebMvcConfigurer datumSubmissionRequestArgumentResolver() {
            return new org.springframework.web.servlet.config.annotation.WebMvcConfigurer() {
                @Override
                public void addArgumentResolvers(java.util.List<org.springframework.web.method.support.HandlerMethodArgumentResolver> resolvers) {
                    resolvers.add(new com.argusvane.datum.submissions.web.mvc.SubmissionRequestResolver());
                }
            };
        }

        @Bean
        @ConditionalOnBooleanProperty(WebSettings.Api.SWITCH_PREFIX + "submissions")
        SubmitMvcController datumSubmitController(SubmissionsApi api) {
            return new SubmitMvcController(api);
        }

        @Bean
        @ConditionalOnBooleanProperty(WebSettings.Api.SWITCH_PREFIX + "validate")
        ValidateMvcController datumValidateController(SubmissionsApi api) {
            return new ValidateMvcController(api);
        }

        @Bean
        @ConditionalOnBooleanProperty(WebSettings.Api.SWITCH_PREFIX + "test")
        TestMvcController datumTestController(SubmissionsApi api) {
            return new TestMvcController(api);
        }

        @Bean
        @ConditionalOnBooleanProperty(WebSettings.Api.SWITCH_PREFIX + "inspect")
        InspectMvcController datumInspectController(SubmissionsApi api) {
            return new InspectMvcController(api);
        }
    }

    /** WebFlux: one router function with the enabled routes. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.REACTIVE)
    @ConditionalOnClass(name = "org.springframework.web.reactive.config.WebFluxConfigurer")
    static class Reactive {

        /** The reactive twin of the MVC resolver: an annotated controller may take a {@code SubmissionRequest} parameter. */
        @Bean
        @ConditionalOnMissingBean(name = "datumSubmissionRequestArgumentResolver")
        org.springframework.web.reactive.config.WebFluxConfigurer datumSubmissionRequestArgumentResolver() {
            return new org.springframework.web.reactive.config.WebFluxConfigurer() {
                @Override
                public void configureArgumentResolvers(org.springframework.web.reactive.result.method.annotation.ArgumentResolverConfigurer configurer) {
                    configurer.addCustomResolver(new com.argusvane.datum.submissions.web.webflux.SubmissionRequestResolver());
                }
            };
        }

        // Springdoc reads annotation values literally (it does not resolve placeholders in a router operation's
        // path), so the operations are annotated at the default base path; DatumSubmissionsOpenApiAutoConfiguration
        // moves the document's path keys to the configured datum.web.api.path.
        private static final String API = "/api";
        private static final String ERRORS = "#/components/schemas/ErrorsBody";

        /** A bean, because springdoc looks the handler class up in the context to read the operation's method. */
        @Bean
        SubmissionsWebFluxHandlers datumSubmissionsHandlers(SubmissionsApi api, ObjectProvider<Scheduler> scheduler) {
            return new SubmissionsWebFluxHandlers(api, scheduler.getIfUnique(Schedulers::boundedElastic));
        }

        @Bean
        @RouterOperations({
            @RouterOperation(path = API + "/submissions", method = RequestMethod.POST,
                beanClass = SubmissionsWebFluxHandlers.class, beanMethod = "submit",
                operation = @Operation(operationId = "submitSubmission", summary = "Deliver a submission", tags = "datum-submissions",
                    description = "{document, submissionKey}: the envelope is validated by the form's own rules in the sandbox, then handed to the application's SubmissionHandler; submissionKey is minted once per submit attempt and sent again on a retry. 409 form.outdated: the page was built from an older version; 409 submission.keyConflict: the key was accepted with another document. A run that failed (wasm.execution_error, outcome_too_large, definition.tooDeep) is 503, never 422: it is no judgement of the answers.",
                    requestBody = @RequestBody(required = true, content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
                    responses = {
                        @ApiResponse(responseCode = "200", description = "The receipt {id, reference, status, digest, receipt?, warnings?}.",
                            content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
                        @ApiResponse(responseCode = "403", description = "Refused by the application's security (access.denied when it installs DatumSecurityResponses).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "404", description = "No such form (form.notFound).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "409", description = "The page was built from an older version of the form (form.outdated), or the submission key was accepted with another document (submission.keyConflict).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))})),
            @RouterOperation(path = API + "/submissions/validate", method = RequestMethod.POST,
                beanClass = SubmissionsWebFluxHandlers.class, beanMethod = "validate",
                operation = @Operation(operationId = "validateSubmission", summary = "Check a journey page or the whole journey", tags = "datum-submissions",
                    description = "{document, scope: page|journey, pageId?}: scope is required, pageId goes with page only (400 otherwise). Answers 200 {accepted, errors, notes?} either way: errors hold only what blocks, notes the warnings and info. A run that failed is no verdict: it answers 503 with the run's code (wasm.execution_error, outcome_too_large, definition.tooDeep), as a submission does. Stores nothing.",
                    requestBody = @RequestBody(required = true, content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
                    responses = {
                        @ApiResponse(responseCode = "200", description = "The verdict {accepted, errors, notes?}.",
                            content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
                        @ApiResponse(responseCode = "403", description = "Refused by the application's security (access.denied when it installs DatumSecurityResponses).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "404", description = "No such form (form.notFound).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "409", description = "The page was built from an older version of the form (form.outdated).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))})),
            @RouterOperation(path = API + "/submissions/test", method = RequestMethod.POST,
                beanClass = SubmissionsWebFluxHandlers.class, beanMethod = "test",
                operation = @Operation(operationId = "testSubmission", summary = "Dry run of a submission (for people who build)", tags = "datum-submissions",
                    description = "Runs every step but calls no handler, publishes no event and records no use; 200 carries the report whether the outcome is accepted or rejected. Off by default.",
                    requestBody = @RequestBody(required = true, content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
                    responses = {
                        @ApiResponse(responseCode = "200", description = "The report. Besides the verdict, the errors and the kept values it names four lists of component ids, each always present and empty when none apply: visibilitySkipped (fields whose own visibleWhen the server could not replay, treated as hidden for requiredness), clientDerived (answers worked out in the browser and kept as sent), clockDependent (components and pages whose rules read the clock) and serverRules (components whose server or server-secret rules the run applied).",
                            content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
                        @ApiResponse(responseCode = "403", description = "Refused by the application's security (access.denied when it installs DatumSecurityResponses).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "404", description = "No such form (form.notFound).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))})),
            @RouterOperation(path = API + "/inspect", method = RequestMethod.POST,
                beanClass = SubmissionsWebFluxHandlers.class, beanMethod = "inspect",
                operation = @Operation(operationId = "inspectDefinition", summary = "The kernel's inspection of a definition (for operators)", tags = "datum-submissions",
                    description = "{form: key} inspects the current full definition, {definition: object} the one given; op is inspect (default) or public. Needs permission to build. Off by default.",
                    requestBody = @RequestBody(required = true, content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
                    responses = {
                        @ApiResponse(responseCode = "200", description = "The kernel's answer {ok, op, ...}.",
                            content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
                        @ApiResponse(responseCode = "403", description = "Refused by the application's security (access.denied when it installs DatumSecurityResponses).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "404", description = "No such form (form.notFound).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))}))})
        RouterFunction<ServerResponse> datumSubmissionsRouterFunction(SubmissionsRoutes routes, SubmissionsWebFluxHandlers handlers,
                                                                    DatumRouteRegistry registry, DatumMethodRules methods) {
            if (routes.enabledRoutes().isEmpty()) {
                return request -> Mono.empty();
            }
            registry.register(routes.enabledRoutes().toArray(String[]::new));
            RouterFunctions.Builder router = RouterFunctions.route();
            if (routes.submitEnabled()) {
                router.POST(routes.submitPath(), handlers::submit);
            }
            if (routes.validateEnabled()) {
                router.POST(routes.validatePath(), handlers::validate);
            }
            if (routes.testEnabled()) {
                router.POST(routes.testPath(), handlers::test);
            }
            if (routes.inspectEnabled()) {
                router.POST(routes.inspectPath(), handlers::inspect);
            }
            // A wrong method answers 405 as MVC does, from the shared method rules (DatumMethodNotAllowedMapping in
            // datum-spring-web, asked only when no controller and no router claimed the request): not a path-wide
            // route here, which would take the path from an application's own controller or router on it and write
            // the 405 itself (forms and the builder work the same way).
            for (String path : routes.enabledRoutes()) {
                methods.allow(path, "POST");
            }
            return router.build();
        }
    }
}
