package com.argusvane.datum.sandbox.endive;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.sandbox.tck.RuntimeTckAssets;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;
import org.junit.jupiter.api.Test;

/**
 * The module Endive compiled is the pinned quickjs-ng release: the download plugin checks the
 * sha256 when it fetches, and this re-hashes whatever file the build compiled ({@code qjs.wasm.file}), so an
 * air-gapped {@code -Dqjs.wasm.file=...} override is held to the same pin.
 */
class QjsPinTest {

    @Test
    void theCompiledModuleIsThePinnedRelease() throws IOException {
        Properties pin = RuntimeInfo.pin();
        String sha256 = pin.getProperty("qjs.sha256");
        assertThat(sha256).as("runtime.properties is filtered from the pom's pin").matches("[0-9a-f]{64}");
        assertThat(pin.getProperty("qjs.version")).matches("\\d+\\.\\d+\\.\\d+");
        assertThat(pin.getProperty("endive.version")).isEqualTo("1.2.0");

        String configured = System.getProperty("qjs.wasm.file");
        Path wasm = configured != null && !configured.isBlank() ? Path.of(configured) : Path.of("target/qjs/qjs-wasi.wasm");
        assertThat(wasm).as("the module the build compiled").isRegularFile();
        byte[] bytes = Files.readAllBytes(wasm);
        assertThat((long) bytes.length).isEqualTo(Long.parseLong(pin.getProperty("qjs.size")));
        assertThat(RuntimeTckAssets.sha256(bytes)).isEqualTo(sha256);
    }
}
