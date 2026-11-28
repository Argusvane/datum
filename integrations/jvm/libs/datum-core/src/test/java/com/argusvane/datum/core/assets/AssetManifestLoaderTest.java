package com.argusvane.datum.core.assets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.io.OutputStream;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class AssetManifestLoaderTest {

    @TempDir
    Path dir;

    private static final String BODY = """
        {"//": "Generated", "buildId": "%s", "source": "abc", "engineVersion": "0.1.0", "sandboxAbi": "1.0.0", "pdfAbi": "1.0.0",
         "knownComponentTypes": ["button", "text"], "builtinBindings": [{"id": "datum", "label": "Datum", "pdfTheme": "datum-pdf"}, {"id": "plain", "label": "Plain"}],
         "builderThemes": [{"id": "datum-dark", "label": "Datum (dark)"}],
         "formTokens": [{"name": "color-text", "group": "palette", "tier": "base", "fallback": "#14212b", "what": "Text."}],
         "omittedFeatures": ["journeys"], "extensions": [{"id": "star-rating"}], "futureField": 1}
        """;

    private Path jar(String name, String buildId) throws IOException {
        Path jar = dir.resolve(name);
        try (OutputStream out = Files.newOutputStream(jar); JarOutputStream jos = new JarOutputStream(out)) {
            jos.putNextEntry(new JarEntry(AssetManifestLoader.RESOURCE));
            jos.write(BODY.formatted(buildId).getBytes(StandardCharsets.UTF_8));
            jos.closeEntry();
        }
        return jar;
    }

    private URLClassLoader loaderOver(Path... jars) throws IOException {
        URL[] urls = new URL[jars.length];
        for (int i = 0; i < jars.length; i++) {
            urls[i] = jars[i].toUri().toURL();
        }
        // No parent, so only the fake jars are seen.
        return new URLClassLoader(urls, null);
    }

    @Test
    void readsEveryField() throws IOException {
        try (URLClassLoader loader = loaderOver(jar("a.jar", "b1"))) {
            AssetManifest manifest = AssetManifestLoader.load(loader);
            assertThat(manifest.buildId()).isEqualTo("b1");
            assertThat(manifest.source()).isEqualTo("abc");
            assertThat(manifest.engineVersion()).isEqualTo("0.1.0");
            assertThat(manifest.sandboxAbi()).isEqualTo("1.0.0");
            assertThat(manifest.pdfAbi()).isEqualTo("1.0.0");
            assertThat(manifest.knownComponentTypes()).containsExactly("button", "text");
            assertThat(manifest.builtinBindings()).containsExactly(new AssetManifest.Binding("datum", "Datum", "datum-pdf"),
                new AssetManifest.Binding("plain", "Plain", null));
            assertThat(manifest.builderThemes()).containsExactly(new AssetManifest.ShellTheme("datum-dark", "Datum (dark)"));
            assertThat(manifest.formTokens()).hasSize(1);
            assertThat(manifest.formTokens().get(0).tier()).isEqualTo("base");
            assertThat(manifest.omittedFeatures()).containsExactly("journeys");
            assertThat(manifest.extensions()).hasSize(1);
            assertThat(manifest.isBuilt()).isTrue();
        }
    }

    @Test
    void jarsThatAgreeAreFine() throws IOException {
        try (URLClassLoader loader = loaderOver(jar("a.jar", "same"), jar("b.jar", "same"))) {
            assertThat(AssetManifestLoader.load(loader).buildId()).isEqualTo("same");
        }
    }

    @Test
    void jarsThatDisagreeOnBuildIdAreRefused() throws IOException {
        try (URLClassLoader loader = loaderOver(jar("a.jar", "one"), jar("b.jar", "two"))) {
            assertThatThrownBy(() -> AssetManifestLoader.load(loader))
                .isInstanceOf(AssetManifestException.class)
                .hasMessageContaining("one")
                .hasMessageContaining("two")
                .extracting(e -> ((AssetManifestException) e).code()).isEqualTo("assets.mismatch");
        }
    }

    @Test
    void noManifestReadsAsADevelopmentBuild() throws IOException {
        try (URLClassLoader loader = loaderOver()) {
            AssetManifest manifest = AssetManifestLoader.load(loader);
            assertThat(manifest.buildId()).isEqualTo("dev");
            assertThat(manifest.engineVersion()).isEqualTo("0.0.0");
            assertThat(manifest.sandboxAbi()).isNull();
            assertThat(manifest.knownComponentTypes()).isEmpty();
            assertThat(manifest.isBuilt()).isFalse();
        }
    }

    @Test
    void aManifestWithoutAStringBuildIdIsRefused() throws IOException {
        for (String body : new String[] {"null", "{}", "{\"buildId\": 7}", "{\"buildId\": \"\"}"}) {
            Path bad = dir.resolve("b" + body.hashCode() + ".jar");
            try (OutputStream out = Files.newOutputStream(bad); JarOutputStream jos = new JarOutputStream(out)) {
                jos.putNextEntry(new JarEntry(AssetManifestLoader.RESOURCE));
                jos.write(body.getBytes(StandardCharsets.UTF_8));
                jos.closeEntry();
            }
            try (URLClassLoader loader = loaderOver(bad)) {
                assertThatThrownBy(() -> AssetManifestLoader.load(loader)).isInstanceOf(AssetManifestException.class);
            }
        }
    }

    @Test
    void anUnreadableManifestIsRefused() throws IOException {
        Path bad = dir.resolve("bad.jar");
        try (OutputStream out = Files.newOutputStream(bad); JarOutputStream jos = new JarOutputStream(out)) {
            jos.putNextEntry(new JarEntry(AssetManifestLoader.RESOURCE));
            jos.write("not json".getBytes(StandardCharsets.UTF_8));
            jos.closeEntry();
        }
        try (URLClassLoader loader = loaderOver(bad)) {
            assertThatThrownBy(() -> AssetManifestLoader.load(loader)).isInstanceOf(AssetManifestException.class);
        }
    }

    @Test
    void verifyAgreementChecksManifestsAlreadyRead() {
        java.util.Map<String, byte[]> agreeing = new java.util.LinkedHashMap<>();
        agreeing.put("datum-ui.jar", BODY.formatted("a9c057bb6c6f").getBytes(StandardCharsets.UTF_8));
        agreeing.put("datum-pdf.jar", BODY.formatted("a9c057bb6c6f").getBytes(StandardCharsets.UTF_8));
        assertThat(AssetManifest.verifyAgreement(agreeing).buildId()).isEqualTo("a9c057bb6c6f");
        assertThat(AssetManifest.verifyAgreement(java.util.Map.of())).isEqualTo(AssetManifest.absent());

        java.util.Map<String, byte[]> mixed = new java.util.LinkedHashMap<>(agreeing);
        mixed.put("old-datum-pdf.jar", BODY.formatted("0123456789ab").getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(() -> AssetManifest.verifyAgreement(mixed)).isInstanceOf(AssetManifestException.class)
            .hasMessageContaining("datum-ui.jar is build a9c057bb6c6f but old-datum-pdf.jar is build 0123456789ab");

        java.util.Map<String, byte[]> broken = java.util.Map.of("bad.jar", "{\"source\": 1}".getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(() -> AssetManifest.verifyAgreement(broken)).isInstanceOf(AssetManifestException.class)
            .hasMessageContaining("bad.jar could not be read");
    }
}
