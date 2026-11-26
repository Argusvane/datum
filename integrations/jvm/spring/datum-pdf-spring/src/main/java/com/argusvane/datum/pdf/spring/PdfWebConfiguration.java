package com.argusvane.datum.pdf.spring;

import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.datasource.DataSourceOptions;
import com.argusvane.datum.web.WebSettings;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import com.argusvane.datum.forms.translation.TranslationCatalogStore;
import com.argusvane.datum.pdf.PdfService;
import com.argusvane.datum.pdf.api.AnswerCheck;
import com.argusvane.datum.pdf.api.PdfApi;
import com.argusvane.datum.pdf.api.PdfDocumentSources;
import com.argusvane.datum.pdf.api.PdfTemplateSource;
import com.argusvane.datum.pdf.config.PdfSettings;
import com.argusvane.datum.pdf.web.FormsPdfDocumentSources;
import com.argusvane.datum.pdf.web.PdfRoutes;
import com.argusvane.datum.pdf.web.mvc.CertificateMvcController;
import com.argusvane.datum.pdf.web.mvc.FillMvcController;
import com.argusvane.datum.pdf.web.mvc.PdfMvcController;
import com.argusvane.datum.pdf.web.mvc.SignMvcController;
import com.argusvane.datum.pdf.web.mvc.VerifyMvcController;
import com.argusvane.datum.pdf.web.webflux.PdfWebFluxHandlers;
import com.argusvane.datum.springweb.spring.DatumProperties;
import com.argusvane.datum.submissions.receiver.SubmissionReceiver;
import com.argusvane.datum.submissions.spi.HostContextProvider;
import com.argusvane.datum.submissions.spi.SubmissionThrottle;
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
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
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

/**
 * The PDF endpoints on whichever web stack the application runs, imported by {@code DatumPdfAutoConfiguration}: MVC
 * {@code @RestController}s marked {@code @DatumController}, or a WebFlux router function whose paths are registered
 * with {@link DatumRouteRegistry} (so only these paths, never the application's own routes, get Datum's error
 * answers). Both call the one {@link PdfApi}. Each endpoint is mapped only when its switch
 * ({@code datum.web.api.endpoints.*}) is on, so a switched-off route is simply absent: 404, and free for the
 * application to map itself. The nested stack configurations follow datum-submissions': an MVC application never
 * loads a WebFlux class and the reverse.
 */
@Configuration(proxyBeanMethods = false)
@ConditionalOnWebApplication
final class PdfWebConfiguration {

    @Bean(name = PdfRoutes.BEAN_NAME)
    PdfRoutes datumPdfRoutes(ObjectProvider<WebSettings> settings, ObjectProvider<DatumProperties> properties) {
        return new PdfRoutes(settings.getIfAvailable(() -> properties.getObject().toSettings()));
    }

    /**
     * What a print request carries beside the answers: datum-forms' translation catalog and data-source options. An
     * application bean of the type replaces it.
     */
    @Bean
    @ConditionalOnMissingBean(PdfDocumentSources.class)
    PdfDocumentSources datumPdfDocumentSources(TranslationCatalogStore catalogs, DataSourceOptions options) {
        return new FormsPdfDocumentSources(catalogs, options);
    }

    @Bean
    @ConditionalOnMissingBean
    PdfApi datumPdfApi(PdfService pdf, SubmissionReceiver receiver, DefinitionService definitions,
                       ObjectProvider<SubmissionThrottle> throttle, DatumJsonMapper json, ProgramLimits limits,
                       PdfDocumentSources sources, ObjectProvider<PdfTemplateSource> templates, PdfSettings settings,
                       ObjectProvider<HostContextProvider> hostContext) {
        return PdfApi.builder()
            .pdf(pdf)
            .check(AnswerCheck.of(receiver))
            .definitions(definitions)
            .throttle(throttle.getIfAvailable())
            .json(json)
            .maxBodyBytes(limits.maxBodyBytes())
            .sources(sources)
            .templates(templates.getIfAvailable(() -> PdfTemplateSource.NONE))
            .serverKeySealsPostedAnswers(settings.seal().postedAnswers())
            // The same HostContextProvider the submission service judges with: the print is drawn under the
            // values its answers were judged under.
            .hostContext(hostContext.getIfAvailable())
            .build();
    }

    /** Spring MVC: controllers, one bean per switch. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.SERVLET)
    @ConditionalOnClass(name = "org.springframework.web.servlet.DispatcherServlet")
    static class Mvc {

        @Bean
        @ConditionalOnBooleanProperty(WebSettings.Api.SWITCH_PREFIX + "pdf")
        PdfMvcController datumPdfController(PdfApi api) {
            return new PdfMvcController(api);
        }

        @Bean
        @ConditionalOnBooleanProperty(WebSettings.Api.SWITCH_PREFIX + "fill")
        FillMvcController datumPdfFillController(PdfApi api) {
            return new FillMvcController(api);
        }

        @Bean
        @ConditionalOnBooleanProperty(WebSettings.Api.SWITCH_PREFIX + "sign")
        SignMvcController datumPdfSignController(PdfApi api) {
            return new SignMvcController(api);
        }

        @Bean
        @ConditionalOnBooleanProperty(WebSettings.Api.SWITCH_PREFIX + "verify")
        VerifyMvcController datumPdfVerifyController(PdfApi api) {
            return new VerifyMvcController(api);
        }

        @Bean
        @ConditionalOnBooleanProperty(WebSettings.Api.SWITCH_PREFIX + "certificate")
        CertificateMvcController datumPdfCertificateController(PdfApi api) {
            return new CertificateMvcController(api);
        }
    }

    /** WebFlux: one router function with the enabled routes. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = Type.REACTIVE)
    @ConditionalOnClass(name = "org.springframework.web.reactive.config.WebFluxConfigurer")
    static class Reactive {

        // Springdoc reads annotation values literally (it does not resolve placeholders in a router operation's
        // path), so the operations are annotated at the default base path; DatumPdfOpenApiAutoConfiguration moves
        // the document's path keys to the configured datum.web.api.path.
        private static final String API = "/api";
        private static final String ERRORS = "#/components/schemas/ErrorsBody";

        /** A bean, because springdoc looks the handler class up in the context to read the operation's method. */
        @Bean
        PdfWebFluxHandlers datumPdfHandlers(PdfApi api, ObjectProvider<Scheduler> scheduler) {
            return new PdfWebFluxHandlers(api, scheduler.getIfUnique(Schedulers::boundedElastic));
        }

        @Bean
        @RouterOperations({
            @RouterOperation(path = API + "/pdf", method = RequestMethod.POST,
                beanClass = PdfWebFluxHandlers.class, beanMethod = "pdf",
                operation = @Operation(operationId = "renderPdf", summary = "The form's PDF of posted answers", tags = "datum-pdf",
                    description = "Body {document, layoutId?, locale?, options?}: the answers are judged first (the receiver's dry run, nothing kept) and the PDF prints the sanitized values. Sealed with a throwaway test certificate unless datum.pdf.seal.posted-answers is on. Headers: X-Page-Count, X-Datum-Layout, X-Datum-Pdf-Theme (the PDF theme the route's binding suggests), X-Signed-By, X-Signature-Field, X-Timestamped.",
                    requestBody = @RequestBody(required = true, content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
                    responses = {
                        @ApiResponse(responseCode = "200", description = "The PDF (application/pdf).",
                            content = @Content(mediaType = "application/pdf", schema = @Schema(type = "string", format = "binary"))),
                        @ApiResponse(responseCode = "400", description = "Malformed request (bad_request, bad_document).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "403", description = "Refused by the application's security (access.denied when it installs DatumSecurityResponses).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "404", description = "No such form or layout (form.notFound, layout.notFound).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "413", description = "Body too large (bad_document).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "415", description = "Not JSON.",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "422", description = "The server does not accept the answers (errors).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "429", description = "Too many requests (flood).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "503", description = "PDF cannot be made now (server.unavailable, server.busy with Retry-After; a run that gave no answer is wasm.execution_error, outcome_too_large or, for a form nested too deep, definition.tooDeep, none with Retry-After).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))})),
            @RouterOperation(path = API + "/pdf/fill", method = RequestMethod.POST,
                beanClass = PdfWebFluxHandlers.class, beanMethod = "fill",
                operation = @Operation(operationId = "fillPdf", summary = "Posted answers written into a template layout's PDF", tags = "datum-pdf",
                    description = "Body {document, layoutId, locale?, options?, template?: {data: base64}}: the layout must be a template layout. A posted template is never sealed with the server's key.",
                    requestBody = @RequestBody(required = true, content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
                    responses = {
                        @ApiResponse(responseCode = "200", description = "The filled PDF (application/pdf).",
                            content = @Content(mediaType = "application/pdf", schema = @Schema(type = "string", format = "binary"))),
                        @ApiResponse(responseCode = "400", description = "Malformed request (bad_request, bad_document, layout.notTemplate).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "403", description = "Refused by the application's security (access.denied when it installs DatumSecurityResponses).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "404", description = "No such form or layout (form.notFound, layout.notFound).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "413", description = "Body too large (bad_document).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "415", description = "Not JSON.",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "422", description = "The server does not accept the answers (errors).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "429", description = "Too many requests (flood).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "503", description = "PDF cannot be made now (server.unavailable, server.busy with Retry-After; a run that gave no answer is wasm.execution_error, outcome_too_large or, for a form nested too deep, definition.tooDeep, none with Retry-After).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))})),
            @RouterOperation(path = API + "/pdf/sign", method = RequestMethod.POST,
                beanClass = PdfWebFluxHandlers.class, beanMethod = "sign",
                operation = @Operation(operationId = "signPdf", summary = "The form's PDF of posted answers, always sealed", tags = "datum-pdf",
                    description = "As POST /pdf, but always sealed: with a throwaway test certificate unless datum.pdf.seal.posted-answers is on. 503 when the server has no signing key.",
                    requestBody = @RequestBody(required = true, content = @Content(mediaType = "application/json", schema = @Schema(type = "object"))),
                    responses = {
                        @ApiResponse(responseCode = "200", description = "The sealed PDF (application/pdf).",
                            content = @Content(mediaType = "application/pdf", schema = @Schema(type = "string", format = "binary"))),
                        @ApiResponse(responseCode = "400", description = "Malformed request (bad_request, bad_document).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "403", description = "Refused by the application's security (access.denied when it installs DatumSecurityResponses).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "404", description = "No such form or layout (form.notFound, layout.notFound).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "413", description = "Body too large (bad_document).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "415", description = "Not JSON.",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "422", description = "The server does not accept the answers (errors).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "429", description = "Too many requests (flood).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "503", description = "No signing key, or PDF cannot be made now (server.unavailable, server.busy with Retry-After; a run that gave no answer is wasm.execution_error, outcome_too_large or, for a form nested too deep, definition.tooDeep, none with Retry-After).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))})),
            @RouterOperation(path = API + "/pdf/verify", method = RequestMethod.POST,
                beanClass = PdfWebFluxHandlers.class, beanMethod = "verify",
                operation = @Operation(operationId = "verifyPdf", summary = "Check the signatures of a posted PDF", tags = "datum-pdf",
                    description = "Body: the PDF itself (application/pdf), up to datum.runtime.verify-max-bytes. Answers the verification report. Who may verify is the application's security (DatumRequestMatchers.pdfVerify()), or switch the route off.",
                    requestBody = @RequestBody(required = true, content = @Content(mediaType = "application/pdf", schema = @Schema(type = "string", format = "binary"))),
                    responses = {
                        @ApiResponse(responseCode = "200", description = "The report {sha256, bytes, signatures, ..., trustPolicy}.",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = "#/components/schemas/PdfVerifyReport"))),
                        @ApiResponse(responseCode = "400", description = "Not a PDF (pdf.notAPdf, pdf.unreadable).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "413", description = "Larger than the cap (bad_document).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "415", description = "Not application/pdf.",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "429", description = "Too many requests (flood).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS))),
                        @ApiResponse(responseCode = "503", description = "PDF cannot be checked now (server.unavailable, server.busy with Retry-After; a run that gave no answer is wasm.execution_error or outcome_too_large, with none).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))})),
            @RouterOperation(path = API + "/server/certificate", method = RequestMethod.GET,
                beanClass = PdfWebFluxHandlers.class, beanMethod = "certificate",
                operation = @Operation(operationId = "serverCertificate", summary = "The server's PDF signing certificate chain", tags = "datum-pdf",
                    description = "PEM, leaf first. 404 certificate.notFound when the server has no signing key.",
                    responses = {
                        @ApiResponse(responseCode = "200", description = "The chain (application/x-pem-file).",
                            content = @Content(mediaType = "application/x-pem-file", schema = @Schema(type = "string"))),
                        @ApiResponse(responseCode = "404", description = "The server has no signing key (certificate.notFound).",
                            content = @Content(mediaType = "application/json", schema = @Schema(ref = ERRORS)))}))})
        RouterFunction<ServerResponse> datumPdfRouterFunction(PdfRoutes routes, PdfWebFluxHandlers handlers, DatumRouteRegistry registry,
                                                              DatumMethodRules methods) {
            if (routes.enabledRoutes().isEmpty()) {
                return request -> Mono.empty();
            }
            registry.register(routes.enabledRoutes().toArray(String[]::new));
            RouterFunctions.Builder router = RouterFunctions.route();
            if (routes.pdfEnabled()) {
                router.POST(routes.pdfPath(), handlers::pdf);
            }
            if (routes.fillEnabled()) {
                router.POST(routes.fillPath(), handlers::fill);
            }
            if (routes.signEnabled()) {
                router.POST(routes.signPath(), handlers::sign);
            }
            if (routes.verifyEnabled()) {
                router.POST(routes.verifyPath(), handlers::verify);
            }
            if (routes.certificateEnabled()) {
                // HEAD as GET, as MVC serves it and datum-forms' router maps it.
                router.GET(routes.certificatePath(), handlers::certificate).HEAD(routes.certificatePath(), handlers::certificate);
            }
            // A wrong method answers 405 as MVC does, from the shared method rules (DatumMethodNotAllowedMapping in
            // datum-spring-web, asked only when no controller and no router claimed the request): not a path-wide
            // route here, which would take the path from an application's own controller or router on it and write
            // the 405 itself (forms and the builder work the same way).
            for (String path : routes.enabledRoutes()) {
                if (path.equals(routes.certificatePath())) {
                    methods.allow(path, "GET", "HEAD");
                } else {
                    methods.allow(path, "POST");
                }
            }
            return router.build();
        }
    }
}
