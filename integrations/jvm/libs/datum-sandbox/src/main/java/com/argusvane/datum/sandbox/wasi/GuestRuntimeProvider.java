package com.argusvane.datum.sandbox.wasi;

import java.util.Objects;

/**
 * An engine, as {@link java.util.ServiceLoader} finds it: an engine module lists its provider in
 * {@code META-INF/services/com.argusvane.datum.sandbox.wasi.GuestRuntimeProvider}, and a host selects one by
 * {@link #id()} through {@link GuestRuntimes#select}. No class name is read from configuration and nothing
 * is loaded by reflection on a name.
 *
 * <p>A provider is cheap to construct and to ask: {@link #id()} and {@link #availability()} must not build an engine,
 * and neither may throw (a provider that does is reported as broken, never chosen). Only {@link #create} does the work.
 * Choosing among providers ({@link GuestRuntimes#select}) throws {@link EngineSelectionException}, a {@link WasiException}
 * and not an {@link IllegalStateException}; the refusals of this layer share one unchecked root on purpose.
 */
public interface GuestRuntimeProvider {

    /**
     * The engine's id: lower case letters, digits and hyphens ({@code endive}), the value that selects it. Two providers
     * with one id on a class path are refused rather than one picked.
     */
    String id();

    /**
     * Whether the engine can run on this JVM and platform (its classes and native code load, the JDK is one it
     * supports), and if not why. An engine with a slower fallback (bytecode) is available and says so in its notes.
     */
    Availability availability();

    /**
     * Makes the runtime. The result is thread-safe; when it is {@link AutoCloseable} its owner closes it at shutdown.
     *
     * @param limits the memory budgets a run may be given, for an engine that must refuse limits it cannot honour (a memory
     *     budget below the module's own initial memory) at creation rather than on the first run
     * @param settings how the harness treats a stopped run
     * @throws EngineConfigurationException when the limits are ones this engine cannot honour ({@link MemoryFloorException});
     *     it is a {@link WasiException}, not an {@link IllegalArgumentException}, so a caller that caught the standard type
     *     for a memory floor must catch this one
     * @throws GuestUnavailableException when the engine cannot be made here after all
     */
    GuestRuntime create(EngineLimits limits, EngineSettings settings);

    /** Whether an engine can run here: {@link Available} or {@link Unavailable}. */
    sealed interface Availability permits Available, Unavailable {

        /** Available, with what an operator should know (the mode it will run in). */
        static Availability available(String notes) {
            return new Available(notes);
        }

        /** Unavailable, and why. */
        static Availability unavailable(String reason) {
            return new Unavailable(reason);
        }

        /** Whether the engine can run here. */
        default boolean isAvailable() {
            return this instanceof Available;
        }
    }

    /** The engine can run here. */
    record Available(String notes) implements Availability {

        public Available {
            notes = notes == null ? "" : notes;
        }
    }

    /** The engine cannot run here, for the reason given. */
    record Unavailable(String reason) implements Availability {

        public Unavailable {
            Objects.requireNonNull(reason, "reason");
        }
    }
}
