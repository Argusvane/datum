package com.argusvane.datum.ui.spring;

import com.argusvane.datum.forms.DefinitionService;
import com.argusvane.datum.forms.FormDefinitionRepository;
import com.argusvane.datum.forms.spring.DatumFormsAutoConfiguration;
import com.argusvane.datum.core.DatumStartupCheck;
import com.argusvane.datum.forms.translation.InMemoryTranslationCatalogStore;
import com.argusvane.datum.forms.translation.TranslationCatalogStore;
import java.util.List;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import com.argusvane.datum.ui.UiSettings;
import com.argusvane.datum.ui.builder.BuilderSaveCustomizer;
import com.argusvane.datum.ui.builder.BuilderSaveValidator;
import com.argusvane.datum.ui.builder.BuilderService;
import com.argusvane.datum.web.assets.DatumAssets;
import java.time.Clock;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;

/**
 * The builder's writes with no transport: the {@link BuilderService} bean wherever this application authors
 * forms ({@code datum.builder.enabled=true}), web application or not, so an import job, a git sync or a command-line
 * runner saves through the kernel's check without the HTTP routes. {@code DatumBuilderAutoConfiguration}'s
 * {@code BuilderApi} is built over this bean, so the routes and every other caller share one service and one set of
 * per-form save locks. An application's own bean of the type replaces it.
 *
 * <p>The application's {@link BuilderSaveCustomizer} and {@link BuilderSaveValidator} beans are collected in
 * the framework's order ({@code @Order}; equal orders keep registration order) and run on every save and create.
 */
@AutoConfiguration(after = {DatumWebAutoConfiguration.class, DatumFormsAutoConfiguration.class, DatumUiAutoConfiguration.class})
@ConditionalOnProperty(prefix = "datum", name = "enabled", matchIfMissing = true)
@ConditionalOnBooleanProperty(name = "datum.builder.enabled")
@ConditionalOnBean({DefinitionService.class, FormDefinitionRepository.class, TranslationCatalogStore.class, DatumAssets.class})
public final class DatumBuilderServiceAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean
    BuilderService datumBuilderService(FormDefinitionRepository repository, DefinitionService definitions, TranslationCatalogStore translations,
                                       DatumAssets assets, ObjectProvider<UiSettings> settings, ObjectProvider<Clock> clock,
                                       ObjectProvider<BuilderSaveCustomizer> customizers, ObjectProvider<BuilderSaveValidator> validators) {
        return service(repository, definitions, translations, assets, settings.getIfAvailable(UiSettings::defaults), clock, customizers, validators);
    }

    /**
     * The translation catalog the builder writes through {@code PUT /forms/{key}/translations} lives in memory unless the
     * application brings a store, so the authors' translations are lost on a restart. A
     * JDBC translation store would need a new shared SQL script, shared by every host; until then the start-up report says so.
     */
    @Bean
    DatumStartupCheck datumBuilderTranslationStoreStartupCheck(ObjectProvider<TranslationCatalogStore> store) {
        return () -> store.orderedStream().anyMatch(InMemoryTranslationCatalogStore.class::isInstance)
            ? List.of(DatumStartupCheck.Notice.warn(DatumBuilderServiceAutoConfiguration.class, "Datum: the builder is on (datum.builder.enabled) and the translation catalogs "
                + "it saves are kept in memory, so they are lost when the application restarts. Provide a TranslationCatalogStore bean "
                + "that stores them."))
            : List.of();
    }

    /**
     * The service from its parts: the component types this host draws come from the assets manifest, the size cap is the
     * routes' ({@code datum.builder.max-definition-size}), so an import is held to what an author could save again.
     */
    static BuilderService service(FormDefinitionRepository repository, DefinitionService definitions, TranslationCatalogStore translations,
                                  DatumAssets assets, UiSettings settings, ObjectProvider<Clock> clock,
                                  ObjectProvider<BuilderSaveCustomizer> customizers, ObjectProvider<BuilderSaveValidator> validators) {
        return BuilderService.builder()
            .repository(repository)
            .definitions(definitions)
            .translations(translations)
            .types(assets.manifest().knownComponentTypes())
            .maxDefinitionBytes(settings.maxDefinitionBytes())
            .clock(clock.getIfAvailable(Clock::systemUTC))
            .customizers(customizers.orderedStream().toList())
            .validators(validators.orderedStream().toList())
            .build();
    }
}
