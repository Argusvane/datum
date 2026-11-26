package com.argusvane.datum.ui.spring;

import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.FormDefinitionRepository;
import com.argusvane.datum.forms.spring.DatumFormsAutoConfiguration;
import com.argusvane.datum.forms.spring.DatumFormsWebAutoConfiguration;
import com.argusvane.datum.forms.translation.TranslationCatalogStore;
import com.argusvane.datum.forms.web.AuthorCopy;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import com.argusvane.datum.springweb.spring.DatumProperties;
import com.argusvane.datum.ui.UiSettings;
import com.argusvane.datum.ui.builder.BuilderApi;
import com.argusvane.datum.ui.builder.BuilderRoutes;
import com.argusvane.datum.ui.builder.BuilderService;
import com.argusvane.datum.ui.builder.LocaleChanges;
import com.argusvane.datum.ui.builder.mvc.BuilderMvcController;
import com.argusvane.datum.ui.builder.webflux.BuilderWebFluxHandlers;
import com.argusvane.datum.springweb.webflux.DatumRouteRegistry;
import com.argusvane.datum.web.WebSettings;
import com.argusvane.datum.web.assets.DatumAssets;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.enums.ParameterIn;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import org.springdoc.core.annotations.RouterOperation;
import org.springdoc.core.annotations.RouterOperations;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication.Type;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;

/**
 * The builder's write endpoints ({@code POST /forms}, {@code PUT /forms/{key}}, {@code PUT /forms/{key}/translations}),
 * and the author's copy on the forms module's definition route ({@code ?public=false}, through {@link AuthorCopy}),
 * on whichever web stack the application runs, only with {@code datum.builder.enabled=true}. Off, nothing is mapped: the paths answer as the application leaves them (404, or 405 beside the
 * forms module's reads).
 *
 * <p>Both stacks call the one {@link BuilderApi}. The MVC controller is a {@code @DatumController}; the WebFlux
 * router registers its paths with {@link DatumRouteRegistry} and is ordered before the forms module's router,
 * whose fallback answers 405 for every method but GET on the translations path. The WebFlux answers to a wrong
 * method are {@link DatumBuilderMethodsAutoConfiguration}'s.
 *
 * <p>Who may write is the application's security (framework-first): datum-spring-web's
 * {@code DatumRequestMatchers.builderWrites()} (and {@code builderReads()} for the author's copy) name these routes in
 * the application's chain, and its start-up check WARNs when the builder is on and no security filter chain exists.
 * The library's {@code BuilderStartupChecks} (registered by {@link DatumUiAutoConfiguration}) says the builder is on.
 */
@AutoConfiguration(after = {DatumWebAutoConfiguration.class, DatumFormsAutoConfiguration.class, DatumFormsWebAutoConfiguration.class,
    DatumUiAutoConfiguration.class, DatumBuilderServiceAutoConfiguration.class})
@ConditionalOnProperty(prefix = "datum", name = "enabled", matchIfMissing = true)
@ConditionalOnBooleanProperty(name = "datum.builder.enabled")
@ConditionalOnWebApplication
@ConditionalOnBean({DefinitionService.class, DatumAssets.class})
@EnableConfigurationProperties(DatumBuilderProperties.class)
public final class DatumBuilderAutoConfiguration {

    /**
     * The builder's paths, from the {@link WebSettings} bean as the forms routes and {@link DatumBuilderMethodsAutoConfiguration}'s
     * method rules take them: an application's own settings bean with another API path moves the writes, the MVC
     * mapping ({@code #{@datumBuilderRoutes.api()}}) and the WebFlux router with it, instead of leaving them on
     * {@code datum.web.api.path} while the {@code Allow}/405 rules moved. The properties' own settings without the bean.
     */
    @Bean(name = BuilderRoutes.BEAN_NAME)
    BuilderRoutes datumBuilderRoutes(ObjectProvider<WebSettings> settings, ObjectProvider<DatumProperties> properties) {
        return new BuilderRoutes(settings.getIfAvailable(() -> properties.getObject().toSettings()));
    }

    /**
     * The builder's read: with the builder on, the forms module's definition route serves the author's copy
     * ({@code public=false}, server-secret rules included) to whoever the application's chain admits through
     * {@code builderReads()}. Without this bean that request is a 404.
     */
    @Bean
    AuthorCopy datumAuthorCopy() {
        return AuthorCopy.SERVED;
    }

    /**
     * The HTTP side of the builder's writes (If-Match, ETag, the 413, the statuses) over the {@link BuilderService} bean
     * ({@link DatumBuilderServiceAutoConfiguration}), so the routes and an application's own callers share one
     * service and one set of per-form save locks. There is no hidden second copy: a
     * context that lists auto-configurations by hand lists {@code DatumBuilderServiceAutoConfiguration} too, or the start
     * stops at once on the missing bean instead of serving routes whose service nobody else can inject.
     */
    @Bean
    @ConditionalOnMissingBean
    BuilderApi datumBuilderApi(BuilderService writes, FormDefinitionRepository repository, TranslationCatalogStore translations,
                               DatumAssets assets, UiSettings settings) {
        return new BuilderApi(writes, repository, translations, settings.maxDefinitionBytes(), assets.apiBase());
    }

    /** Spring MVC: the controller. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.SERVLET)
    @ConditionalOnClass(name = "org.springframework.web.servlet.DispatcherServlet")
    static class Mvc {

        @Bean
        BuilderMvcController datumBuilderController(BuilderApi api) {
            return new BuilderMvcController(api);
        }
    }

    /** WebFlux: one router function, ahead of the forms module's. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.REACTIVE)
    @ConditionalOnClass(name = "org.springframework.web.reactive.config.WebFluxConfigurer")
    static class Reactive {

        // Springdoc reads annotation values literally, so the operations are annotated at the default base path;
        // DatumBuilderOpenApiAutoConfiguration moves the document's keys to the configured datum.web.api.path.
        private static final String API = "/api";
        private static final String ERRORS = "#/components/schemas/ErrorsBody";

        /** A bean, because springdoc looks the handler class up in the context to read the operation's method. */
        @Bean
        BuilderWebFluxHandlers datumBuilderHandlers(BuilderApi api, ObjectProvider<Scheduler> scheduler) {
            return new BuilderWebFluxHandlers(api, scheduler.getIfUnique(Schedulers::boundedElastic));
        }

        @Bean
        @Order(Ordered.HIGHEST_PRECEDENCE + 100)
        @RouterOperations({
            @RouterOperation(path = API + "/forms", method = RequestMethod.POST, beanClass = BuilderWebFluxHandlers.class, beanMethod = "create",
                operation = @Operation(operationId = "createForm", summary = "Create a form from a definition", tags = "datum-ui",
                    description = "The form key is the definition's id. The definition is checked by the sandbox kernel before it is stored.",
                    requestBody = @io.swagger.v3.oas.annotations.parameters.RequestBody(required = true, description = "The form definition.",
                        content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
                    parameters = @Parameter(name = LocaleChanges.HEADER, in = ParameterIn.HEADER,
                        description = "The builder's language changes, JSON {removed: [codes], renamed: [{from, to}]}."),
                    responses = {
                        @ApiResponse(responseCode = "201", description = "Created: {key, version, sha256, savedAt, catalog, warnings, kernelWarnings}.",
                            content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
                        @ApiResponse(responseCode = "403", description = "Refused by the application's security: building is for some people only (access.denied when it installs DatumSecurityResponses).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "409", description = "A form has this id already (form.exists).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "422", description = "Refused by the shape check or the kernel: errors[].code and kernel[].code name each finding (for example pattern.risky), with no top-level code; a too-deep or too-costly definition carries the top-level code definition.tooDeep or definition.tooCostly.",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "501", description = "The form repository is read-only (forms.readOnly).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))})),
            @RouterOperation(path = API + "/forms/{key}", method = RequestMethod.PUT, beanClass = BuilderWebFluxHandlers.class, beanMethod = "update",
                operation = @Operation(operationId = "saveForm", summary = "Save a form's definition", tags = "datum-ui",
                    description = "Order of refusals: 403, 404, 415, 413, 409 (If-Match is not the current hash), 400 (not JSON), 422 (shape, id, kernel verdict), 503 (the sandbox could not check it). Nothing is stored on any refusal.",
                    requestBody = @io.swagger.v3.oas.annotations.parameters.RequestBody(required = true, description = "The form definition; its id must be the key.",
                        content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
                    parameters = {
                        @Parameter(name = "key", in = ParameterIn.PATH, required = true, description = "The form key."),
                        @Parameter(name = "If-Match", in = ParameterIn.HEADER, description = "The ETag of the definition this save builds on."),
                        @Parameter(name = LocaleChanges.HEADER, in = ParameterIn.HEADER,
                            description = "The builder's language changes, JSON {removed: [codes], renamed: [{from, to}]}.")},
                    responses = {
                        @ApiResponse(responseCode = "200", description = "Saved: {key, version, sha256, savedAt, catalog, warnings, kernelWarnings}; X-Datum-Removed-Locales lists the locales the save removed.",
                            content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
                        @ApiResponse(responseCode = "403", description = "Refused by the application's security: building is for some people only (access.denied when it installs DatumSecurityResponses).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "404", description = "No such form (form.notFound).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "409", description = "The form changed since it was loaded (form.outdated).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "422", description = "Refused by the shape check or the kernel: errors[].code and kernel[].code name each finding (for example pattern.risky), with no top-level code; a too-deep or too-costly definition carries the top-level code definition.tooDeep or definition.tooCostly.",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "501", description = "The form repository is read-only (forms.readOnly).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))})),
            @RouterOperation(path = API + "/forms/{key}/translations", method = RequestMethod.PUT, beanClass = BuilderWebFluxHandlers.class,
                beanMethod = "translations",
                operation = @Operation(operationId = "saveFormTranslations", summary = "Save a form's host translation catalog", tags = "datum-ui",
                    requestBody = @io.swagger.v3.oas.annotations.parameters.RequestBody(required = true, description = "{catalog: {locale: {kind: {owner: tree}}}}, or the catalog itself.",
                        content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
                    parameters = {
                        @Parameter(name = "key", in = ParameterIn.PATH, required = true, description = "The form key."),
                        @Parameter(name = "If-Match", in = ParameterIn.HEADER, description = "The ETag of the catalog this save builds on.")},
                    responses = {
                        @ApiResponse(responseCode = "200", description = "Saved: {catalog, entries, savedAt}.",
                            content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
                        @ApiResponse(responseCode = "403", description = "Refused by the application's security: building is for some people only (access.denied when it installs DatumSecurityResponses).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "404", description = "No such form (form.notFound).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "409", description = "The catalog changed since it was loaded (form.outdated).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "422", description = "Not a catalog (catalog.invalid).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))}))})
        RouterFunction<ServerResponse> datumBuilderRouterFunction(BuilderRoutes routes, BuilderWebFluxHandlers handlers,
                                                                  DatumRouteRegistry registry) {
            registry.register(routes.routes().toArray(String[]::new));
            // Only the writes themselves come first; a wrong method is answered by DatumBuilderMethodsAutoConfiguration's
            // fallback, which runs after the application's own routes (a path-wide 405 here would take an
            // application's DELETE on /forms/{key} away).
            RouterFunctions.Builder router = RouterFunctions.route()
                .POST(routes.createPath(), handlers::create)
                .PUT(routes.formPath(), handlers::update)
                .PUT(routes.translationsPath(), handlers::translations);
            return router.build();
        }
    }
}
