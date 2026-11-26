package com.argusvane.datum.springweb.spring;

/**
 * Class names a capability's documentation auto-configuration orders itself before.
 *
 * <p>Springdoc's {@code MultipleOpenApiSupportConfiguration} is conditional on a {@code GroupedOpenApi} bean
 * existing when it is evaluated; a group defined by an auto-configuration that runs after it is silently
 * missing (the document answers 404 for the group). Every capability that defines a group therefore declares
 * {@code @AutoConfiguration(after = DatumOpenApiAutoConfiguration.class, beforeName = {SPRINGDOC_CONFIGURATION,
 * SPRINGDOC_WEBMVC_MULTIPLE, SPRINGDOC_WEBFLUX_MULTIPLE})} and {@code @ConditionalOnClass(name = GROUPED_OPEN_API)}.
 * Strings, so the classes need not be present.
 *
 * <p>Spring wiring only, so it lives in the binding package with the auto-configurations that name it, and no library type carries springdoc names.
 */
public final class DatumOpenApi {

    public static final String GROUPED_OPEN_API = "org.springdoc.core.models.GroupedOpenApi";
    public static final String SPRINGDOC_CONFIGURATION = "org.springdoc.core.configuration.SpringDocConfiguration";
    public static final String SPRINGDOC_WEBMVC_MULTIPLE =
        "org.springdoc.webmvc.core.configuration.MultipleOpenApiSupportConfiguration";
    public static final String SPRINGDOC_WEBFLUX_MULTIPLE =
        "org.springdoc.webflux.core.configuration.MultipleOpenApiSupportConfiguration";

    private DatumOpenApi() {
    }
}
