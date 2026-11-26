package com.argusvane.datum.ui;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.ui.spring.DatumBuilderProperties;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;
import tools.jackson.databind.json.JsonMapper;

class BuilderFilesTest {

    @Test
    void theListAndTheNameRulesBothWithhold() {
        BuilderFiles files = new BuilderFiles(Set.of("Special/Chunk.js"));
        assertThat(files.isBuilderFile("special/chunk.js")).isTrue();
        assertThat(files.isBuilderFile("datum-builder-anything.js")).isTrue();
        assertThat(files.isBuilderFile("builder-fonts/x.woff2")).isTrue();
        assertThat(files.isBuilderFile("builder-files.json")).isTrue();
        assertThat(files.isBuilderFile("datum-form.js")).isFalse();
        assertThat(files.isBuilderFile("fonts/geist.woff2")).isFalse();
        assertThat(files.isBuilderFile(null)).isFalse();
    }

    @Test
    void theJarsListIsRead() {
        BuilderFiles files = BuilderFiles.load(getClass().getClassLoader(), JsonMapper.builder().build());
        assertThat(files.size()).isGreaterThan(10);
        assertThat(files.isBuilderFile("datum-builder.js")).isTrue();
    }

    @Test
    void anAbsentListLeavesTheNameRules() {
        BuilderFiles files = BuilderFiles.load(new ClassLoader(null) { }, JsonMapper.builder().build());
        assertThat(files.size()).isZero();
        assertThat(files.isBuilderFile("datum-builder.js")).isTrue();
    }

    @Test
    void theGateOpensOnlyWithTheSwitch() {
        BuilderFiles files = new BuilderFiles(Set.of());
        DatumBuilderProperties off = new DatumBuilderProperties();
        assertThat(new BuilderAssetGate(files, off.toSettings()).withheld("datum-builder.js")).isTrue();
        assertThat(new BuilderAssetGate(files, off.toSettings()).withheld("datum-form.js")).isFalse();
        off.setEnabled(true);
        assertThat(new BuilderAssetGate(files, off.toSettings()).withheld("datum-builder.js")).isFalse();
        assertThat(new DatumBuilderProperties().toSettings()).as("the literal defaults are the library's").isEqualTo(UiSettings.defaults());
    }

    @Test
    void propertiesDefaultAndBind() {
        DatumBuilderProperties defaults = new DatumBuilderProperties();
        assertThat(defaults.isEnabled()).isFalse();
        assertThat(defaults.getMaxDefinitionSize().toBytes()).isEqualTo(1024 * 1024);
        DatumBuilderProperties bound = new Binder(new MapConfigurationPropertySource(
            Map.of("datum.builder.enabled", "true", "datum.builder.max-definition-size", "256KB")))
            .bind("datum.builder", DatumBuilderProperties.class).get();
        assertThat(bound.isEnabled()).isTrue();
        assertThat(bound.getMaxDefinitionSize().toBytes()).isEqualTo(256 * 1024);
    }
}
