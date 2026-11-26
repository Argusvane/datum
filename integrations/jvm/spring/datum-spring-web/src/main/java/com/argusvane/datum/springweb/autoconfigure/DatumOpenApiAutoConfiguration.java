package com.argusvane.datum.springweb.autoconfigure;

import com.argusvane.datum.springweb.spring.DatumOpenApi;
import com.argusvane.datum.springweb.spring.DatumOpenApiSupport;
import com.argusvane.datum.web.WebSettings;
import com.argusvane.datum.web.openapi.DatumOpenApiRegistry;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;

/**
 * Provides {@link DatumOpenApiSupport} when springdoc is on the classpath, ordered before springdoc's own
 * auto-configurations so the groups the capability modules define after it are seen.
 */
@AutoConfiguration(after = DatumWebAutoConfiguration.class, beforeName = {
    DatumOpenApi.SPRINGDOC_CONFIGURATION,
    DatumOpenApi.SPRINGDOC_WEBMVC_MULTIPLE,
    DatumOpenApi.SPRINGDOC_WEBFLUX_MULTIPLE})
@ConditionalOnClass(name = DatumOpenApi.GROUPED_OPEN_API)
@ConditionalOnProperty(prefix = "datum", name = "enabled", matchIfMissing = true)
@ConditionalOnProperty(prefix = "datum.web.openapi", name = "enabled", matchIfMissing = true)
public final class DatumOpenApiAutoConfiguration {

    @Bean
    DatumOpenApiSupport datumOpenApiSupport(WebSettings settings, DatumOpenApiRegistry registry) {
        return new DatumOpenApiSupport(settings, registry);
    }
}
