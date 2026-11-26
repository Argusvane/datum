package com.argusvane.datum.sandbox.endive;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import run.endive.redline.experimental.api.NativeCode;
import run.endive.redline.experimental.api.NativeMachineFactoryProvider;
import run.endive.runtime.GlobalInstance;
import run.endive.runtime.Instance;
import run.endive.runtime.Memory;
import run.endive.runtime.TableInstance;
import run.endive.wasm.WasmModule;
import run.endive.wasm.types.MemoryLimits;
import run.endive.wasm.types.MutabilityType;
import run.endive.wasm.types.Table;
import run.endive.wasm.types.Value;

/**
 * The provider selection: Panama only on
 * 25+, by name, a LinkageError passes to JFFI, nothing usable is the bytecode path; and on this test class path (JFFI
 * only) the compiled class resolves a native runner.
 */
class ProviderSelectorTest {

    private static final ClassLoader LOADER = ProviderSelectorTest.class.getClassLoader();
    private static final String WORKING = WorkingProvider.class.getName();
    /** Initialisations of NeverInitialisedProvider: a class literal loads a class without initialising it. */
    static final AtomicInteger INITIALISED = new AtomicInteger();
    private static final String COUNTED = NeverInitialisedProvider.class.getName();
    private static final String BROKEN_INIT = BrokenInitProvider.class.getName();
    private static final String NO_NATIVE_LIB = UnlinkedProvider.class.getName();
    private static final String ABSENT = "run.endive.redline.experimental.runner.NoSuchProvider";

    @Test
    void theCompiledClassIsOnTheClassPathWithNativeCodeForThisPlatform() throws Exception {
        assertThat(Class.forName("com.argusvane.datum.sandbox.endive.Qjs")).isSameAs(Qjs.class);
        assertThat(EndiveGuestRuntime.QJS_PAGES).isPositive();
        assertThat(EndiveGuestRuntime.minimumMemoryBytes()).isEqualTo(EndiveGuestRuntime.QJS_PAGES * 65536L);
        assertThat(Qjs.loadNativeCode()).as("a Redline blob for " + ProviderSelector.platform()).isNotNull();
    }

    @Test
    void thisClassPathResolvesTheJffiRunner() {
        ProviderSelector.Selection selection = ProviderSelector.select();
        assertThat(selection.runner()).isEqualTo(Runner.JFFI);
        assertThat(selection.provider().getClass().getName()).isEqualTo(Runner.JFFI.providerClass());
        try (EndiveGuestRuntime runtime = new EndiveGuestRuntime(selection)) {
            assertThat(runtime.nativeProvider()).isEqualTo("jffi");
            assertThat(runtime.isNative()).isTrue();
            assertThat(runtime.info().qjsSha256()).matches("[0-9a-f]{64}");
            assertThat(runtime.info().providerClass()).isEqualTo(Runner.JFFI.providerClass());
        }
    }

    @Test
    void belowJava25ThePanamaClassIsNeverLoaded() {
        ProviderSelector.Selection selection = ProviderSelector.select(17, true, LOADER, COUNTED, WORKING);
        assertThat(selection.runner()).isEqualTo(Runner.JFFI);
        assertThat(INITIALISED).as("not even Class.forName on 17-24").hasValue(0);
        assertThat(selection.reason()).contains("needs Java 25+");
        assertThat(ProviderSelector.select(24, true, LOADER, COUNTED, WORKING).runner()).isEqualTo(Runner.JFFI);
        assertThat(INITIALISED).hasValue(0);
    }

    @Test
    void onJava25PanamaWinsWhenItLoads() {
        ProviderSelector.Selection selection = ProviderSelector.select(25, true, LOADER, WORKING, ABSENT);
        assertThat(selection.runner()).isEqualTo(Runner.PANAMA);
        assertThat(selection.provider()).isInstanceOf(WorkingProvider.class);
    }

    @Test
    void aMissingOrBrokenPanamaRunnerFallsToJffi() {
        assertThat(ProviderSelector.select(25, true, LOADER, ABSENT, WORKING).runner()).isEqualTo(Runner.JFFI);
        // A LinkageError (here ExceptionInInitializerError, on 17 an UnsupportedClassVersionError) is caught.
        ProviderSelector.Selection broken = ProviderSelector.select(26, true, LOADER, BROKEN_INIT, WORKING);
        assertThat(broken.runner()).isEqualTo(Runner.JFFI);
        assertThat(broken.reason()).contains("BrokenInitProvider").contains("cannot be loaded");
    }

    @Test
    void aRunnerThatCannotMapMemoryIsPassedOver() {
        // A JFFI runner without its native jar loads, then fails every run: the probe finds it at start.
        ProviderSelector.Selection selection = ProviderSelector.select(17, true, LOADER, ABSENT, NO_NATIVE_LIB);
        assertThat(selection.runner()).isEqualTo(Runner.BYTECODE);
        assertThat(selection.reason()).contains("cannot map native memory").contains("UnsatisfiedLinkError");
    }

    @Test
    void noUsableRunnerOrNoNativeCodeIsTheBytecodePath() {
        ProviderSelector.Selection none = ProviderSelector.select(25, true, LOADER, ABSENT, ABSENT);
        assertThat(none.runner()).isEqualTo(Runner.BYTECODE);
        assertThat(none.provider()).isNull();
        assertThat(none.reason()).contains("no Redline runner is usable");

        ProviderSelector.Selection noCode = ProviderSelector.select(25, false, LOADER, COUNTED, COUNTED);
        assertThat(noCode.runner()).isEqualTo(Runner.BYTECODE);
        assertThat(noCode.reason()).contains("no Redline native code");
        assertThat(INITIALISED).as("no native code: no runner is even loaded").hasValue(0);
    }

    @Test
    void aSelectionPairsNativeRunnersWithProviders() {
        assertThatThrownBy(() -> new ProviderSelector.Selection(Runner.JFFI, null, "x")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ProviderSelector.Selection(Runner.BYTECODE, new WorkingProvider(), "x"))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void theLoaderReportsWhatItPassedOver() {
        List<String> passed = new ArrayList<>();
        assertThat(ProviderSelector.load(ABSENT, LOADER, passed)).isNull();
        assertThat(ProviderSelector.load(String.class.getName(), LOADER, passed)).as("not a provider").isNull();
        assertThat(passed).hasSize(2);
        assertThat(passed.get(0)).contains("not on the class path");
        assertThat(passed.get(1)).contains("cannot be constructed");
    }

    /** A provider that works (it never builds an instance here). */
    public static class WorkingProvider implements NativeMachineFactoryProvider {
        public WorkingProvider() {
        }

        @Override
        public Instance.Builder builder(WasmModule module, NativeCode code) {
            throw new UnsupportedOperationException();
        }

        @Override
        public Memory createMemory(MemoryLimits limits) {
            return null;
        }

        @Override
        public TableInstance createImportTable(Table table, int index) {
            throw new UnsupportedOperationException();
        }

        @Override
        public GlobalInstance createImportGlobal(Value value, MutabilityType mutability) {
            throw new UnsupportedOperationException();
        }

        @Override
        public int priority() {
            return 1;
        }
    }

    /** Counts its initialisation; only ever named where the selector must not load it. */
    public static class NeverInitialisedProvider extends WorkingProvider {
        static {
            INITIALISED.incrementAndGet();
        }
    }

    /** A class whose initialisation fails: a LinkageError at Class.forName. */
    public static class BrokenInitProvider extends WorkingProvider {
        static final int BOOM = boom();

        private static int boom() {
            throw new IllegalStateException("static init fails");
        }
    }

    /** A provider whose native half is missing, as JFFI without jffi's native jar. */
    public static class UnlinkedProvider extends WorkingProvider {
        @Override
        public Memory createMemory(MemoryLimits limits) {
            throw new UnsatisfiedLinkError("could not locate stub library in jar file");
        }
    }
}
