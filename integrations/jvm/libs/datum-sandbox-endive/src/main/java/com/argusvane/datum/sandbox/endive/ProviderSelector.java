package com.argusvane.datum.sandbox.endive;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import run.endive.redline.experimental.api.NativeMachineFactoryProvider;
import run.endive.runtime.Instance;
import run.endive.runtime.Memory;
import run.endive.wasm.types.MemoryLimits;

/**
 * Picks the machine QuickJS runs on, once: Panama on Java 25+, else JFFI, else the bytecode path.
 *
 * <p>Never {@code Qjs.builder()} nor {@code Qjs.nativeProvider()}: both go through
 * {@code NativeMachineFactoryProvider.discover()}, whose {@code ServiceLoader} loop catches a {@code LinkageError} only
 * around {@code next()}, while Java 17's lazy class-path iterator loads the provider class in {@code hasNext()}; with
 * the Panama runner (class-file version 69) on the class path every Java 17-24 run then dies with an
 * {@code UnsupportedClassVersionError}. Here each runner is loaded by name, on the Java
 * versions it supports, and any {@code LinkageError} moves on to the next, so an application may ship both selector
 * poms.
 *
 * <p>A runner that loads is also asked for one page of native memory before it is chosen: a JFFI runner without its
 * native jar loads fine and then fails every run with an {@code UnsatisfiedLinkError}, and Panama
 * under {@code --illegal-native-access=deny} throws {@code IllegalCallerException}; either falls to the next
 * runner at start, with a WARN, instead of failing every run. (Merely loading the class is not
 * enough.)
 *
 * <p>When no runner is usable, or the jar has no native code for this platform ({@code Qjs.loadNativeCode()} is
 * {@code null}, which {@code -Dendive.redline.os.arch=riscv64} forces), QuickJS runs as bytecode with a WARN naming the
 * platform.
 */
public final class ProviderSelector {

    private static final Logger LOG = LoggerFactory.getLogger(ProviderSelector.class);

    /**
     * Whether this module had native access before any runner was probed, read when this class is first used. Read this
     * early on purpose: in the JDK's default {@code --illegal-native-access=warn} mode, the first restricted
     * call from a module (the Panama runner's probe below) prints the JVM's warning and then enables native access for
     * that module, so a later {@code isNativeAccessEnabled()} answers true and a WARN naming the fix would never fire.
     * Best effort: the state belongs to the class loader's whole unnamed module, so a restricted call by
     * another class-path library before this class loads enables it first and the WARN stays silent (a missed WARN,
     * never a false one); the JVM's own "restricted method" warning is the authoritative signal.
     */
    private static final Boolean NATIVE_ACCESS_BEFORE_SELECTION = nativeAccessEnabled(ProviderSelector.class.getModule());

    private ProviderSelector() {
    }

    /** Whether this module had native access before the first runner was probed; null before JDK 21 (no such method). */
    static Boolean nativeAccessBeforeSelection() {
        return NATIVE_ACCESS_BEFORE_SELECTION;
    }

    /** {@code module.isNativeAccessEnabled()} on JDK 21+, or null where the method does not exist. */
    static Boolean nativeAccessEnabled(Module module) {
        try {
            Method method = Module.class.getMethod("isNativeAccessEnabled");
            Object answer = method.invoke(module);
            return answer instanceof Boolean flag ? flag : null;
        } catch (NoSuchMethodException e) {
            return null;
        } catch (ReflectiveOperationException | RuntimeException e) {
            return null;
        }
    }

    /**
     * The machine chosen.
     *
     * @param runner which one
     * @param provider the native provider, {@code null} for {@link Runner#BYTECODE}
     * @param reason why it was chosen, and what was passed over, for the start-up log
     */
    public record Selection(Runner runner, NativeMachineFactoryProvider provider, String reason) {

        public Selection {
            Objects.requireNonNull(runner, "runner");
            if (runner.isNative() != (provider != null)) {
                throw new IllegalArgumentException("A native runner has a provider and only a native runner has one.");
            }
        }

        /**
         * A fresh instance builder for the compiled module: {@code provider.builder(Qjs.load(), Qjs.loadNativeCode())}
         * for a native runner, {@code Qjs.safeBuilder()} for bytecode. The caller sets the imports, the memory limits
         * and {@code withStart(false)}.
         */
        public Instance.Builder builder() {
            return provider != null ? provider.builder(Qjs.load(), Qjs.loadNativeCode()) : Qjs.safeBuilder();
        }
    }

    /** The selection for this JVM: its feature version, this library's class loader and the generated class's natives. */
    public static Selection select() {
        return select(Runtime.version().feature(), Qjs.loadNativeCode() != null, ProviderSelector.class.getClassLoader(),
            Runner.PANAMA.providerClass(), Runner.JFFI.providerClass());
    }

    /**
     * The selection rule, with its inputs open for tests.
     *
     * @param feature the Java feature version ({@code Runtime.version().feature()})
     * @param nativeCode whether the compiled class carries native code for this platform
     * @param loader where the runners are looked for
     * @param panamaClass the Panama provider's class name
     * @param jffiClass the JFFI provider's class name
     */
    static Selection select(int feature, boolean nativeCode, ClassLoader loader, String panamaClass, String jffiClass) {
        List<String> passed = new ArrayList<>();
        if (!nativeCode) {
            return bytecode("the jar has no Redline native code for " + platform(), passed);
        }
        if (feature >= 25) {
            NativeMachineFactoryProvider panama = load(panamaClass, loader, passed);
            if (panama != null) {
                return new Selection(Runner.PANAMA, panama, "Java " + feature + " with the Panama runner" + passedOver(passed));
            }
        } else {
            // Not even a Class.forName: on Java 17-24 the Panama runner cannot load, and saying why is noise.
            passed.add("panama (needs Java 25+, this is Java " + feature + ")");
        }
        NativeMachineFactoryProvider jffi = load(jffiClass, loader, passed);
        if (jffi != null) {
            return new Selection(Runner.JFFI, jffi, "Java " + feature + " with the JFFI runner" + passedOver(passed));
        }
        return bytecode("no Redline runner is usable on " + platform(), passed);
    }

    private static Selection bytecode(String why, List<String> passed) {
        return new Selection(Runner.BYTECODE, null, why + passedOver(passed));
    }

    private static String passedOver(List<String> passed) {
        return passed.isEmpty() ? "" : " (passed over: " + String.join("; ", passed) + ")";
    }

    /**
     * One runner by name, or {@code null} with the reason added to {@code passed}. A runner that is absent is passed
     * over quietly; one that is present and cannot load or cannot map memory is passed over with a WARN, since the
     * application asked for it.
     */
    static NativeMachineFactoryProvider load(String className, ClassLoader loader, List<String> passed) {
        Class<?> type;
        try {
            type = Class.forName(className, true, loader);
        } catch (ClassNotFoundException e) {
            passed.add(simpleName(className) + " (not on the class path)");
            return null;
        } catch (LinkageError e) {
            // UnsupportedClassVersionError, NoClassDefFoundError, ExceptionInInitializerError, UnsatisfiedLinkError.
            return passOver(className, "cannot be loaded: " + e, passed, e);
        }
        NativeMachineFactoryProvider provider;
        try {
            provider = type.asSubclass(NativeMachineFactoryProvider.class).getDeclaredConstructor().newInstance();
        } catch (ReflectiveOperationException | LinkageError | RuntimeException e) {
            // RuntimeException includes the ClassCastException of a class that is not a provider.
            return passOver(className, "cannot be constructed: " + e, passed, e);
        }
        try {
            probe(provider);
        } catch (LinkageError | RuntimeException e) {
            return passOver(className, "cannot map native memory: " + e, passed, e);
        }
        return provider;
    }

    /** One page of the runner's native memory, freed at once: proves its native half links and may map memory. */
    private static void probe(NativeMachineFactoryProvider provider) {
        Memory memory = provider.createMemory(new MemoryLimits(1, 1));
        if (memory instanceof AutoCloseable closeable) {
            try {
                closeable.close();
            } catch (Exception e) {
                throw new IllegalStateException("could not free the probe page", e);
            }
        }
    }

    private static NativeMachineFactoryProvider passOver(String className, String why, List<String> passed, Throwable cause) {
        passed.add(simpleName(className) + " (" + why + ")");
        LOG.warn("Datum Endive runtime: the runner {} is on the class path but {}; trying the next one.", simpleName(className), why, cause);
        return null;
    }

    private static String simpleName(String className) {
        return className.substring(className.lastIndexOf('.') + 1);
    }

    /**
     * The platform as Endive's {@code RedlineTarget.detectHost()} reads it: {@code endive.redline.os.name} and
     * {@code endive.redline.os.arch} before {@code os.name} and {@code os.arch}.
     */
    static String platform() {
        String os = System.getProperty("endive.redline.os.name", System.getProperty("os.name"));
        String arch = System.getProperty("endive.redline.os.arch", System.getProperty("os.arch"));
        return os + "/" + arch + " (Java " + Runtime.version().feature() + ")";
    }
}
