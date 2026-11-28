package com.argusvane.datum.sandbox.endive;

import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.tck.PdfRenderContract;
import org.junit.jupiter.api.AfterAll;

/**
 * The PDF program on Endive renders the parity documents byte for byte as the Node kernel does: datum-sandbox-tck's
 * {@link PdfRenderContract}. Runs in the failsafe executions, on a native runner (JFFI, or Panama on 25+).
 */
class PdfRenderIT implements PdfRenderContract {

    private static final EndiveGuestRuntime RUNTIME = new EndiveGuestRuntime();

    @AfterAll
    static void stop() {
        RUNTIME.close();
    }

    @Override
    public GuestRuntime runtime() {
        return RUNTIME;
    }
}
