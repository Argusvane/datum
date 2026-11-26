package com.argusvane.datum.starter.test;

import com.argusvane.datum.forms.FormDefinitionRepository;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;

/**
 * The fixture forms as the repository, for {@code @AutoConfigureDatum(testForms = true)}, which sets
 * {@code datum.test.forms=true} through {@code @PropertyMapping}. Ordered before the forms binding so its resource repository
 * backs off; an application's own {@code FormDefinitionRepository} bean still wins.
 */
@AutoConfiguration(beforeName = "com.argusvane.datum.forms.spring.DatumFormsAutoConfiguration")
@ConditionalOnProperty(prefix = "datum.test", name = "forms", havingValue = "true")
final class DatumTestFormsAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean(FormDefinitionRepository.class)
    DatumTestForms.Repository datumTestFormRepository() {
        return DatumTestForms.repository();
    }
}
