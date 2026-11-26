package com.argusvane.datum.pdf;

import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.argusvane.datum.sandbox.wasi.GuestRuntime;

/**
 * {@link KernelScenarios} on the real PDF program evaluated by Node ({@link NodeGuestRuntime}): the kernel's own
 * answers for the host's signing flow while datum-sandbox-endive is not installed. Skipped when no {@code node} 18+ is
 * on the PATH. Not a substitute for {@link PdfRealRuntimeIT}, which runs the same scenarios on Endive.
 */
class NodeKernelIT extends KernelScenarios {

    @Override
    GuestRuntime engine() {
        assumeTrue(NodeGuestRuntime.available(), "No node 18+ on the PATH: the Node-evaluated kernel scenarios are skipped.");
        return new NodeGuestRuntime();
    }
}
