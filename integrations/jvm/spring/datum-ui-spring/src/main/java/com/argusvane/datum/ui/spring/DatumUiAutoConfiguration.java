package com.argusvane.datum.ui.spring;

import com.argusvane.datum.core.DatumStartupCheck;
import com.argusvane.datum.springweb.autoconfigure.DatumWebAutoConfiguration;
import com.argusvane.datum.ui.BuilderAssetGate;
import com.argusvane.datum.ui.BuilderFiles;
import com.argusvane.datum.ui.BuilderStartupChecks;
import com.argusvane.datum.ui.UiSettings;
import com.argusvane.datum.web.json.DatumJsonMapper;
import com.argusvane.datum.web.monitoring.DatumCapability;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnResource;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.core.io.ResourceLoader;

/**
 * The ui module's beans: the asset gate and the {@code datum.builder.*} properties.
 *
 * <p>The assets themselves are served by {@code datum-spring-web}'s handler, which finds them under
 * {@code META-INF/datum/assets/} on the class path, so this module only decides which of them may leave: the
 * form files always, the builder files when {@code datum.builder.enabled}. The write endpoints
 * ({@code ...ui.builder}) are registered by their own auto-configuration under the same switch.
 *
 * <p>The condition is the form bundle itself: a jar without it (a build that skipped the assets) switches the
 * module off rather than serving nothing under a ui name.
 *
 * <p>The Spring binding of the ui library: {@link UiSettings} is the one switch. With the builder on,
 * the start says so (a {@link DatumStartupCheck}); who may build is the application's
 * security, and datum-spring-web's start-up check WARNs when no security filter chain exists.
 */
@AutoConfiguration(after = DatumWebAutoConfiguration.class)
@ConditionalOnProperty(prefix = "datum", name = "enabled", matchIfMissing = true)
@ConditionalOnResource(resources = "classpath:/META-INF/datum/assets/datum-form.js")
@EnableConfigurationProperties(DatumBuilderProperties.class)
public final class DatumUiAutoConfiguration {

    @Bean
    BuilderFiles datumBuilderFiles(ResourceLoader resources, DatumJsonMapper json) {
        return BuilderFiles.load(resources.getClassLoader(), json.mapper());
    }

    /** {@code datum.builder.*} as the library reads it. */
    @Bean
    @ConditionalOnMissingBean
    UiSettings datumUiSettings(DatumBuilderProperties properties) {
        return properties.toSettings();
    }

    @Bean
    BuilderAssetGate datumBuilderAssetGate(BuilderFiles files, UiSettings settings) {
        return new BuilderAssetGate(files, settings);
    }

    /** The ui capability and its {@code builder} detail, a bean of its own, read from the settings bean. */
    @Bean
    DatumCapability datumUiCapability(UiSettings settings) {
        return DatumCapability.of("ui").withDetail("builder", settings::builderEnabled);
    }

    /**
     * The builder's start-up line (the library's {@link BuilderStartupChecks}): with the builder on, says so and that
     * the application's security decides who may use it. Run once every bean exists, by datum-spring-web's runner.
     */
    @Bean
    DatumStartupCheck datumBuilderStartupCheck(UiSettings settings) {
        return BuilderStartupChecks.check(settings);
    }
}
