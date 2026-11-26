package com.argusvane.datum.sandbox.endive;

import com.argusvane.datum.sandbox.wasi.EngineLimits;
import com.argusvane.datum.sandbox.wasi.EngineSettings;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.wasi.GuestRuntimeProvider;
import com.argusvane.datum.sandbox.wasi.MemoryFloorException;
import java.util.Objects;

/**
 * Endive as a {@link GuestRuntimeProvider}: registered in this jar's {@code META-INF/services}, selected by
 * the id {@code endive} (the default of {@code datum.runtime.engine}).
 *
 * <p>Constructing the provider loads nothing; {@link #availability()} picks the runner once ({@link ProviderSelector}: the
 * generated {@code Qjs} class, its native code for this platform, one page of a runner's native memory) and keeps the
 * choice for {@link #create}, so the selection's WARNs are logged once. Endive is available on every platform its class
 * loads on: without native code it runs as bytecode, which the notes say (no PDF program there). It is unavailable when
 * the JDK is older than 17 or the precompiled module cannot be loaded at all.
 */
public final class EndiveRuntimeProvider implements GuestRuntimeProvider {

    private volatile ProviderSelector.Selection selection;

    @Override
    public String id() {
        return EndiveGuestRuntime.ID;
    }

    @Override
    public Availability availability() {
        int feature = Runtime.version().feature();
        if (feature < 17) {
            return Availability.unavailable("Endive needs Java 17 or later; this is Java " + feature + ".");
        }
        try {
            ProviderSelector.Selection chosen = selection();
            long initial = EndiveGuestRuntime.minimumMemoryBytes();
            return Availability.available(chosen.runner().isNative()
                ? "QuickJS on the " + chosen.runner().id() + " runner (" + chosen.reason() + "); initial memory " + initial + " bytes."
                : "QuickJS as JVM bytecode (" + chosen.reason() + "): validation is several times slower and the PDF program "
                    + "is unavailable.");
        } catch (RuntimeException | LinkageError e) {
            return Availability.unavailable("the precompiled QuickJS module cannot be loaded on " + ProviderSelector.platform() + ": " + e);
        }
    }

    @Override
    public GuestRuntime create(EngineLimits limits, EngineSettings settings) {
        Objects.requireNonNull(limits, "limits");
        Objects.requireNonNull(settings, "settings");
        requireMemory(limits.minMemoryBytes());
        return new EndiveGuestRuntime(selection(), settings);
    }

    /**
     * Refuses at creation a least memory budget below the module's own initial memory, which no run could honour. Typed
     * so the layer above names its budget's property and the fix instead of a stack trace: the Datum lifecycle turns
     * it into {@code EngineMemoryFloorException}, a {@code DatumConfigurationException}.
     */
    static void requireMemory(long bytes) {
        long least = EndiveGuestRuntime.minimumMemoryBytes();
        if (bytes < least) {
            throw new MemoryFloorException(bytes, least, "QuickJS module");
        }
    }

    private ProviderSelector.Selection selection() {
        ProviderSelector.Selection chosen = selection;
        if (chosen == null) {
            synchronized (this) {
                chosen = selection;
                if (chosen == null) {
                    chosen = ProviderSelector.select();
                    selection = chosen;
                }
            }
        }
        return chosen;
    }
}
