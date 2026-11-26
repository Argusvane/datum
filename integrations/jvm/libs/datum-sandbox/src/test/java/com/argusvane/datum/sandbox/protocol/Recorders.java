package com.argusvane.datum.sandbox.protocol;

import com.argusvane.datum.sandbox.diagnostics.RunRecorder;
import org.jspecify.annotations.Nullable;

/** The recorder a built service holds, for the runtime's diagnostics tests in another package. */
public final class Recorders {

    private Recorders() {
    }

    /** The recorder of a sandbox the runtime built (undecorated: no observations, no decorators). */
    public static @Nullable RunRecorder of(Sandbox sandbox) {
        return ((SandboxService) sandbox).recorder();
    }

    /** The recorder of a PDF program the runtime built (undecorated). */
    public static @Nullable RunRecorder of(PdfKernel kernel) {
        return ((PdfProgram) kernel).recorder();
    }
}
