package com.argusvane.datum.forms.web;

import com.argusvane.datum.core.hooks.HookRefusedException;
import com.argusvane.datum.forms.DefinitionCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;

/**
 * Two {@link DefinitionCustomizer} beans declared in the opposite order of their {@code @Order}: the first stamps
 * the definition with the request's locale and refuses or fails for two magic locales, the second appends to the stamp.
 */
@Configuration(proxyBeanMethods = false)
public class DefinitionCustomizerBeans {

    @Bean
    @Order(2)
    DefinitionCustomizer appendsSecond() {
        return draft -> draft.definition().put("stamp", draft.definition().path("stamp").asString("") + ",second");
    }

    @Bean
    @Order(1)
    DefinitionCustomizer stampsFirst() {
        return draft -> {
            String locale = draft.request().locale() == null ? "" : draft.request().locale().toLanguageTag();
            if (locale.equals("xx")) {
                throw HookRefusedException.forbidden("tenant.closed", "This form is closed for your organization.");
            }
            if (locale.equals("yy")) {
                throw new IllegalStateException("the tenant directory is down");
            }
            draft.definition().put("stamp", "first");
            draft.definition().put("locale", locale);
        };
    }
}
