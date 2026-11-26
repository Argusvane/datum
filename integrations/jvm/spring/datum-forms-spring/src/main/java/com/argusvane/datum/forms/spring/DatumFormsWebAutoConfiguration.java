package com.argusvane.datum.forms.spring;

import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.FormDefinitionRepository;
import com.argusvane.datum.forms.FormsSettings;
import com.argusvane.datum.forms.datasource.DataSourceOptions;
import com.argusvane.datum.forms.translation.TranslationCatalogStore;
import com.argusvane.datum.forms.web.AuthorCopy;
import com.argusvane.datum.forms.web.FormsApi;
import com.argusvane.datum.forms.web.FormsRoutes;
import com.argusvane.datum.forms.web.mvc.DataSourcesMvcController;
import com.argusvane.datum.forms.web.mvc.DefinitionMvcController;
import com.argusvane.datum.forms.web.webflux.FormsWebFluxHandlers;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import com.argusvane.datum.springweb.spring.DatumProperties;
import com.argusvane.datum.springweb.webflux.DatumMethodRules;
import com.argusvane.datum.springweb.webflux.DatumRouteRegistry;
import com.argusvane.datum.web.json.DatumJsonMapper;
import com.argusvane.datum.web.monitoring.DatumCapability;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.enums.ParameterIn;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import org.springdoc.core.annotations.RouterOperation;
import org.springdoc.core.annotations.RouterOperations;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import com.argusvane.datum.web.WebSettings;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication.Type;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.reactive.function.server.RequestPredicates;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Scheduler;
import reactor.core.scheduler.Schedulers;
import org.springframework.beans.factory.ObjectProvider;

/**
 * The forms read endpoints on whichever web stack the application runs: MVC {@code @RestController}s marked
 * {@code @DatumController}, or a WebFlux router function whose paths are registered with
 * {@link DatumRouteRegistry} (so only these paths, never the application's own routes, get Datum's error
 * answers). Both call the one {@link FormsApi}. Each endpoint is mapped only when its switch
 * ({@code datum.web.api.endpoints.*}) is on, so a switched-off route is simply absent: 404, and free for the
 * application to map itself.
 *
 * <p>The nested stack configurations follow the pattern of {@code DatumWebAutoConfiguration}: an MVC
 * application never loads a WebFlux class and the reverse.
 */
@AutoConfiguration(after = {DatumFormsAutoConfiguration.class, DatumWebAutoConfiguration.class})
@ConditionalOnProperty(prefix = "datum", name = "enabled", matchIfMissing = true)
@ConditionalOnWebApplication
public final class DatumFormsWebAutoConfiguration {

    @Bean(name = FormsRoutes.BEAN_NAME)
    FormsRoutes datumFormsRoutes(ObjectProvider<WebSettings> settings, ObjectProvider<DatumProperties> properties) {
        // The WebSettings bean when the application (or the web auto-configuration) made one, else the properties' own.
        return new FormsRoutes(settings.getIfAvailable(() -> properties.getObject().toSettings()));
    }

    /**
     * The forms capability, a bean of its own: an application's {@link FormsApi} replaces the facade and
     * keeps the definition routes in the start-up notice, {@code info.datum} and {@code host.json}.
     */
    @Bean
    DatumCapability datumFormsCapability() {
        return DatumCapability.of("forms");
    }

    /**
     * The facade. The author's copy ({@code public=false}) is served only when an {@link AuthorCopy} bean says so, which the
     * builder's auto-configuration declares while {@code datum.builder.enabled} is on; without it that request is a 404, so a
     * host that only shows forms never hands out a server-secret rule, whatever its security chain admits.
     */
    @Bean
    @ConditionalOnMissingBean
    FormsApi datumFormsApi(DefinitionService definitions, FormDefinitionRepository repository, TranslationCatalogStore translations,
                           DataSourceOptions dataSources, DatumJsonMapper json, FormsSettings settings, ObjectProvider<AuthorCopy> authorCopy) {
        return new FormsApi(definitions, repository, translations, dataSources, json, settings.definitionCacheControl(),
            settings.snapshotCacheControl(), authorCopy.getIfAvailable(() -> AuthorCopy.WITHHELD));
    }

    /** Spring MVC: controllers, one configuration per switch. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.SERVLET)
    @ConditionalOnClass(name = "org.springframework.web.servlet.DispatcherServlet")
    static class Mvc {

        @Bean
        @ConditionalOnBooleanProperty(WebSettings.Api.SWITCH_PREFIX + "definition")
        DefinitionMvcController datumDefinitionController(FormsApi api) {
            return new DefinitionMvcController(api);
        }

        @Bean
        @ConditionalOnBooleanProperty(WebSettings.Api.SWITCH_PREFIX + "data-sources")
        DataSourcesMvcController datumDataSourcesController(FormsApi api) {
            return new DataSourcesMvcController(api);
        }
    }

    /** WebFlux: one router function with the enabled routes. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.REACTIVE)
    @ConditionalOnClass(name = "org.springframework.web.reactive.config.WebFluxConfigurer")
    static class Reactive {

        // Springdoc reads annotation values literally (it does not resolve placeholders in a router operation's
        // path), so the operations are annotated at the default base path; DatumFormsOpenApiAutoConfiguration
        // moves the document's path keys to the configured datum.web.api.path.
        private static final String API = "/api";
        private static final String ERRORS = "#/components/schemas/ErrorsBody";

        /** A bean, because springdoc looks the handler class up in the context to read the operation's method. */
        @Bean
        FormsWebFluxHandlers datumFormsHandlers(FormsApi api, ObjectProvider<Scheduler> scheduler) {
            return new FormsWebFluxHandlers(api, scheduler.getIfUnique(Schedulers::boundedElastic));
        }

        @Bean
        @RouterOperations({
            @RouterOperation(path = API + "/forms/{key}/definition", method = org.springframework.web.bind.annotation.RequestMethod.GET,
                beanClass = FormsWebFluxHandlers.class, beanMethod = "definition",
                operation = @Operation(operationId = "getFormDefinition", summary = "A form's definition", tags = "datum-forms",
                    description = "The public copy by default (server-secret rules removed); public=false is served only while the builder is on (datum.builder.enabled), else 404, and needs permission to build; sha256 serves that version.",
                    parameters = {
                        @Parameter(name = "key", in = ParameterIn.PATH, required = true, description = "The form key."),
                        @Parameter(name = "public", in = ParameterIn.QUERY, description = "true (default) for the public copy, false for the full definition.",
                            schema = @Schema(type = "boolean", defaultValue = "true")),
                        @Parameter(name = "sha256", in = ParameterIn.QUERY, description = "A version of the form by hash.", schema = @Schema(type = "string")),
                        @Parameter(name = "If-None-Match", in = ParameterIn.HEADER, description = "The ETag of the copy the client holds.")},
                    responses = {
                        @ApiResponse(responseCode = "200", description = "The definition.",
                            content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
                        @ApiResponse(responseCode = "304", description = "The client's copy is current."),
                        @ApiResponse(responseCode = "400", description = "public is not true or false (bad_request).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "403", description = "Refused by the application's security (access.denied when it installs DatumSecurityResponses).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "404", description = "No such form or version (form.notFound); public=false with the builder off (no body).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))})),
            @RouterOperation(path = API + "/forms/{key}/translations", method = org.springframework.web.bind.annotation.RequestMethod.GET,
                beanClass = FormsWebFluxHandlers.class, beanMethod = "translations",
                operation = @Operation(operationId = "getFormTranslations", summary = "A form's host translation catalog", tags = "datum-forms",
                    parameters = {
                        @Parameter(name = "key", in = ParameterIn.PATH, required = true, description = "The form key."),
                        @Parameter(name = "If-None-Match", in = ParameterIn.HEADER, description = "The ETag of the catalog the client holds.")},
                    responses = {
                        @ApiResponse(responseCode = "200", description = "{catalog: {locale: {kind: {owner: tree}}}}.",
                            content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
                        @ApiResponse(responseCode = "304", description = "The client's catalog is current."),
                        @ApiResponse(responseCode = "403", description = "Refused by the application's security (access.denied when it installs DatumSecurityResponses).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "404", description = "No such form (form.notFound).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))})),
            @RouterOperation(path = API + "/data-sources/{id}", method = org.springframework.web.bind.annotation.RequestMethod.GET,
                beanClass = FormsWebFluxHandlers.class, beanMethod = "dataSource",
                operation = @Operation(operationId = "getDataSourceItems", summary = "A data source's options", tags = "datum-forms",
                    parameters = {
                        @Parameter(name = "id", in = ParameterIn.PATH, required = true, description = "The data source id."),
                        @Parameter(name = "locale", in = ParameterIn.QUERY, description = "A locale code such as fr-CA."),
                        @Parameter(name = "form", in = ParameterIn.QUERY, description = "The form being filled; the application's security may read it (the per-form recipe).")},
                    responses = {
                        @ApiResponse(responseCode = "200", description = "{items: [{value, label, description?}]}.",
                            content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
                        @ApiResponse(responseCode = "403", description = "Refused by the application's security (access.denied when it installs DatumSecurityResponses).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "404", description = "No provider, or an unknown source (data_source.notFound).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))}))})
        RouterFunction<ServerResponse> datumFormsRouterFunction(FormsRoutes routes, FormsWebFluxHandlers handlers, DatumRouteRegistry registry,
                                                                DatumMethodRules methods) {
            if (routes.enabledRoutes().isEmpty()) {
                return request -> Mono.empty();
            }
            registry.register(routes.enabledRoutes().toArray(String[]::new));
            RouterFunctions.Builder router = RouterFunctions.route();
            if (routes.definitionEnabled()) {
                router.GET(routes.definitionPath(), handlers::definition).HEAD(routes.definitionPath(), handlers::definition);
                router.GET(routes.translationsPath(), handlers::translations).HEAD(routes.translationsPath(), handlers::translations);
            }
            if (routes.dataSourcesEnabled()) {
                router.GET(routes.dataSourcePath(), handlers::dataSource).HEAD(routes.dataSourcePath(), handlers::dataSource);
            }
            // HEAD is served as MVC serves it for a GET mapping (the server drops the body). A wrong method answers 405
            // as MVC does, from the shared method rules (DatumMethodNotAllowedMapping): not a path-wide route here,
            // which would take the path from an application's own controller or router on it.
            for (String path : routes.enabledRoutes()) {
                methods.allow(path, "GET", "HEAD");
            }
            return router.build();
        }
    }
}
