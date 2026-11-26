package com.argusvane.datum.web.assets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

/**
 * Runs the page glue's node harness ({@code src/test/js/datum-host.test.mjs}): submit(), builder() and passkeys()
 * against a fake fetch and fake elements, no browser. Skipped, with the reason, when no {@code node} 20+ is on the
 * PATH, so a Java-only machine still builds; where the {@code CI} environment variable is set it fails instead.
 */
class GlueHarnessTest {

    private static final Path HARNESS = Path.of("src/test/js/datum-host.test.mjs");

    private static int nodeMajor() {
        try {
            Process process = new ProcessBuilder("node", "--version").redirectErrorStream(true).start();
            String out = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
            if (!process.waitFor(10, TimeUnit.SECONDS) || process.exitValue() != 0 || !out.startsWith("v")) {
                return 0;
            }
            return Integer.parseInt(out.substring(1, out.indexOf('.')));
        } catch (IOException | NumberFormatException e) {
            return 0;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return 0;
        }
    }

    @Test
    void theGlueHarnessPasses() throws Exception {
        int node = nodeMajor();
        // CI must not go green with the glue cases unrun: where the CI variable is set, a missing node fails.
        if (System.getenv("CI") != null && !System.getenv("CI").isBlank() && !"false".equalsIgnoreCase(System.getenv("CI"))) {
            assertThat(node).as("CI needs node 20+ on the PATH to run the page glue harness").isGreaterThanOrEqualTo(20);
        }
        assumeTrue(node >= 20, "No node 20+ on the PATH: the page glue harness is skipped.");
        assumeTrue(Files.exists(HARNESS), "Run from libs/datum-web-core: " + HARNESS + " was not found.");
        Process process = new ProcessBuilder("node", "--test", HARNESS.toString()).redirectErrorStream(true).start();
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertThat(process.waitFor(120, TimeUnit.SECONDS)).as("node finished").isTrue();
        assertThat(process.exitValue()).as(output).isZero();
    }
}
