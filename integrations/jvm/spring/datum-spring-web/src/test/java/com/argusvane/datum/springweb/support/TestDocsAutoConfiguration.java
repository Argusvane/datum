package com.argusvane.datum.springweb.support;

import com.argusvane.datum.springweb.autoconfigure.DatumOpenApiAutoConfiguration;
import com.argusvane.datum.springweb.spring.DatumOpenApi;
import com.argusvane.datum.springweb.spring.DatumOpenApiSupport;
import java.util.List;
import org.springdoc.core.models.GroupedOpenApi;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;

/** A stand-in capability: defines a group the way a real capability module does (ordering included). */
@AutoConfiguration(after = DatumOpenApiAutoConfiguration.class, beforeName = {
    DatumOpenApi.SPRINGDOC_CONFIGURATION,
    DatumOpenApi.SPRINGDOC_WEBMVC_MULTIPLE,
    DatumOpenApi.SPRINGDOC_WEBFLUX_MULTIPLE})
@ConditionalOnClass(name = DatumOpenApi.GROUPED_OPEN_API)
@ConditionalOnProperty("datum.test.docs")
public class TestDocsAutoConfiguration {

    @Bean
    GroupedOpenApi datumTestGroup(DatumOpenApiSupport support) {
        return support.group("test", List.of("/test/**"), List.of("/test/hidden/**"));
    }
}
