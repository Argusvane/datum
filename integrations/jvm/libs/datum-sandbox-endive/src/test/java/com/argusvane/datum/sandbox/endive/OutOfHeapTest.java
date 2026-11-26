package com.argusvane.datum.sandbox.endive;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.concurrent.ExecutionException;
import org.junit.jupiter.api.Test;
import run.endive.runtime.TrapException;
import run.endive.runtime.WasmRuntimeException;
import run.endive.wasm.WasmEngineException;

/**
 * What counts as the JVM out of heap, which the runtime reports as the host's interruption and never as the guest's
 * memory budget (a heap spike from other requests must not make a definition "too costly").
 */
class OutOfHeapTest {

    @Test
    void theJvmsOwnOutOfMemoryAndTheEnginesWrapOfItAreTheHosts() {
        assertThat(EndiveGuestRuntime.outOfHeap(new OutOfMemoryError("Java heap space"))).isTrue();
        // Endive's interpreter and constant evaluators wrap a caught OutOfMemoryError this way.
        assertThat(EndiveGuestRuntime.outOfHeap(new WasmEngineException("out of memory", new OutOfMemoryError()))).isTrue();
        assertThat(EndiveGuestRuntime.outOfHeap(new WasmEngineException("out of memory"))).isTrue();
        assertThat(EndiveGuestRuntime.outOfHeap(new ExecutionException(new OutOfMemoryError()))).isTrue();
    }

    @Test
    void trapsAndOtherFaultsAreNot() {
        assertThat(EndiveGuestRuntime.outOfHeap(new TrapException("call stack exhausted"))).isFalse();
        assertThat(EndiveGuestRuntime.outOfHeap(new WasmRuntimeException("out of bounds memory access"))).isFalse();
        assertThat(EndiveGuestRuntime.outOfHeap(new StackOverflowError())).isFalse();
        assertThat(EndiveGuestRuntime.outOfHeap(new IllegalStateException("out of memory"))).isFalse();
    }
}
