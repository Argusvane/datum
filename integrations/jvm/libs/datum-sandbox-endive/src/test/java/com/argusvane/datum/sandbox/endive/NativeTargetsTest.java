package com.argusvane.datum.sandbox.endive;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeFalse;

import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Test;
import run.endive.redline.experimental.api.internal.RedlineTarget;

/**
 * The default build carries Redline native code for all six targets. A jar built with {@code -Pdev-native} holds the host's target only and would run as bytecode, with
 * the PDF path refused, everywhere else; this test fails such a jar unless the build says it is dev-native (the
 * profile sets {@code datum.devNative=true}), and the release profile refuses dev-native outright.
 */
class NativeTargetsTest {

    /** Redline 1.1.0's targets, by the suffix of the resource the generated class loads. */
    private static final List<String> SIX = List.of("x86_64-linux", "aarch64-linux", "x86_64-darwin", "aarch64-darwin",
        "x86_64-windows", "aarch64-windows");

    @Test
    void theJarCarriesNativeCodeForEveryTarget() {
        assumeFalse(Boolean.getBoolean("datum.devNative"), "a dev-native build carries the host's target only");
        assertThat(Arrays.stream(RedlineTarget.values()).map(RedlineTarget::resourceSuffix))
            .as("Redline's own target list; a new one needs a decision and a line here").containsExactlyInAnyOrderElementsOf(SIX);
        for (String suffix : SIX) {
            assertThat(Qjs.class.getResource("Qjs." + suffix + ".native")).as("native code for " + suffix).isNotNull();
        }
    }
}
