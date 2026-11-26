package com.argusvane.datum.pdf;

import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.argusvane.datum.sandbox.wasi.EngineSettings;
import com.argusvane.datum.sandbox.runtime.Engines;
import com.argusvane.datum.sandbox.wasi.GuestRuntimes;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;

/**
 * {@link KernelScenarios} on the production runtime: datum-sandbox-endive's {@code EndiveGuestRuntime} (QuickJS
 * compiled by Endive, the JFFI runner, or Panama on 25+ when its selector is present). Runs with
 * {@code -Ddatum.engine=endive}, which adds the engine and its JFFI selector to the test class path (the
 * {@code engine-endive} profile); skipped with a message otherwise, so a module build does not need the engine
 * installed. Asked for and absent is a failure, not a skip.
 */
class PdfRealRuntimeIT extends KernelScenarios {

    @Override
    GuestRuntime engine() {
        String engine = System.getProperty("datum.engine", "");
        assumeTrue("endive".equals(engine), "The real-runtime IT runs with -Ddatum.engine=endive (datum-sandbox-endive and its JFFI selector "
            + "installed): skipped.");
        // Through the engine SPI, as a host binding selects it: a missing or unavailable engine is a failure
        // naming the ids found, not a skip.
        return Engines.create(GuestRuntimes.select(engine, PdfRealRuntimeIT.class.getClassLoader()),
            ProgramLimits.builder().pdfSeconds(60).build(), EngineSettings.defaults());
    }
}
