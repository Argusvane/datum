package com.argusvane.datum.pdf;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.sandbox.wasi.EngineInfo;
import com.argusvane.datum.sandbox.protocol.ProgramRunner;
import com.argusvane.datum.sandbox.protocol.HostOptions;
import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.runtime.DatumSandbox;
import com.argusvane.datum.sandbox.runtime.ProgramStore;
import com.argusvane.datum.sandbox.runtime.SandboxStatus;
import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The bytecode fallback is a permanent platform fact only while the runtime is up: a runtime
 * that is not up is an outage, which health must show as DOWN, so the permanent reason is withheld.
 */
class PdfRuntimePermanenceTest {

    /** An engine on its bytecode fallback: it says it cannot run the PDF program. */
    public static final class BytecodeRunner implements GuestRuntime {

        @Override
        public EngineInfo engineInfo() {
            return new EngineInfo("test", "1", EngineInfo.BYTECODE, "No native code here.");
        }

        @Override
        public RunOutput run(com.argusvane.datum.sandbox.wasi.GuestRun run) {
            throw new UnsupportedOperationException("not started in this test");
        }
    }

    @Test
    void aRuntimeThatIsNotUpIsNeverReportedAsAPermanentFact() {
        DatumSandbox runtime = DatumSandbox.builder().runtime(new BytecodeRunner()).store(new ProgramStore(ProgramStore.class.getClassLoader(), null, null))
            .limits(ProgramLimits.defaults()).hostOptions(HostOptions.defaults())
            .settings(com.argusvane.datum.sandbox.runtime.SandboxSettings.builder().engine("test").failFast(true).warmUpRuns(0).shutdownGrace(Duration.ofSeconds(1)).pdfConcurrency(1).pdfWait(Duration.ZERO).build()).events((com.argusvane.datum.core.DatumEventPublisher) event -> { })
            .runLog(com.argusvane.datum.sandbox.protocol.RunLog.slf4j()).build();
        PdfRuntime pdf = PdfRuntime.of(runtime);
        assertThat(runtime.status().state()).isNotEqualTo(SandboxStatus.State.UP);
        assertThat(pdf.engine().mode()).isEqualTo("bytecode");
        assertThat(ProgramRunner.canRunPdf(pdf.engine())).isFalse();
        assertThat(pdf.permanentlyUnavailable()).isNull();
    }

    /**
     * The permanent reason is a fixed sentence of the engine's id and mode: its notes (Endive's carry a passed-over
     * runner's exception text, which can name a native library's file path) never reach the PDF health reason.
     */
    @Test
    void thePermanentReasonNamesTheEngineAndItsModeButNotItsNotes() {
        EngineInfo engine = new EngineInfo("test", "1", EngineInfo.BYTECODE, "cannot be loaded: /private/var/folders/x/libjffi.dylib");
        PdfRuntime pdf = new PdfRuntime() {
            @Override
            public com.argusvane.datum.sandbox.protocol.PdfProgram program() {
                throw new UnsupportedOperationException();
            }

            @Override
            public com.argusvane.datum.sandbox.protocol.RunSlots slots() {
                throw new UnsupportedOperationException();
            }

            @Override
            public EngineInfo engine() {
                return engine;
            }

            @Override
            public java.util.Map<String, String> contextKeys() {
                return java.util.Map.of();
            }

            @Override
            public int pdfSeconds() {
                return 1;
            }
        };
        assertThat(pdf.permanentlyUnavailable()).isEqualTo("The PDF program cannot run on the test engine here (mode bytecode).")
            .doesNotContain("libjffi");
    }
}
