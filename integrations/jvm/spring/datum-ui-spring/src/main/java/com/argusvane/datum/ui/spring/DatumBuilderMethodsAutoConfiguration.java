package com.argusvane.datum.ui.spring;

import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.spring.DatumFormsAutoConfiguration;
import com.argusvane.datum.forms.spring.DatumFormsWebAutoConfiguration;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import com.argusvane.datum.springweb.spring.DatumProperties;
import com.argusvane.datum.ui.builder.BuilderRoutes;
import com.argusvane.datum.springweb.webflux.DatumMethodRules;
import com.argusvane.datum.web.assets.DatumAssets;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication.Type;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.Bean;
import com.argusvane.datum.web.WebSettings;
import org.springframework.beans.factory.ObjectProvider;

/**
 * The WebFlux answer to a wrong method on the builder's paths: 405 with an {@code Allow} header naming every method
 * Datum serves there, as Spring MVC answers from all its mappings of the path.
 *
 * <p>The 405 itself is {@code DatumMethodNotAllowedMapping} in datum-spring-web, a handler mapping ordered after the
 * annotated controllers and the router functions: an application's own {@code DELETE /api/forms/{key}} (a router
 * route or an annotated controller) answers on WebFlux as on MVC, because the mapping is reached only by a request
 * nothing else handles. This class only says which methods the builder serves. It runs before
 * {@link DatumFormsWebAutoConfiguration} so the forms module's GET and HEAD join the same {@code Allow}. The
 * conditions are {@link DatumBuilderAutoConfiguration}'s.
 */
@AutoConfiguration(after = {DatumWebAutoConfiguration.class, DatumFormsAutoConfiguration.class},
    before = DatumFormsWebAutoConfiguration.class)
@ConditionalOnProperty(prefix = "datum", name = "enabled", matchIfMissing = true)
@ConditionalOnBooleanProperty(name = "datum.builder.enabled")
@ConditionalOnWebApplication(type = Type.REACTIVE)
@ConditionalOnClass(name = "org.springframework.web.reactive.config.WebFluxConfigurer")
@ConditionalOnBean({DefinitionService.class, DatumAssets.class})
public final class DatumBuilderMethodsAutoConfiguration {

    /**
     * Registers the methods the builder serves on its paths with the shared rules; the union with the forms
     * module's GET and HEAD is the {@code Allow} value. Held as a bean only so it runs at start.
     */
    @Bean
    BuilderMethodRules datumBuilderMethodRules(ObjectProvider<WebSettings> settings, ObjectProvider<DatumProperties> properties,
                                               DatumMethodRules methods) {
        BuilderRoutes routes = new BuilderRoutes(settings.getIfAvailable(() -> properties.getObject().toSettings()));
        methods.allow(routes.formPath(), "PUT");
        methods.allow(routes.translationsPath(), "PUT");
        methods.allow(routes.createPath(), "POST");
        return new BuilderMethodRules();
    }

    /** Marker for {@link #datumBuilderMethodRules}: the registration has run. */
    record BuilderMethodRules() {
    }
}
