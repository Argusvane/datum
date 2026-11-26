package com.argusvane.datum.sandbox.runtime;

import com.argusvane.datum.core.DatumConfigurationException;
import org.jspecify.annotations.Nullable;

/**
 * A run's memory budget is below the least an engine can start in (the engine's own initial memory): no run could honour
 * it, so the engine refuses at start rather than at the first run. A {@link DatumConfigurationException}
 * naming the budget's property, which is what a host prints: what {@link Engines#create} makes of the engine's own
 * {@link com.argusvane.datum.sandbox.wasi.MemoryFloorException}, which knows no property.
 */
public final class EngineMemoryFloorException extends DatumConfigurationException {

    private static final long serialVersionUID = 1L;

    private final long bytes;
    private final long least;

    /**
     * @param property the budget's property ({@code datum.runtime.validation.memory}, {@code datum.runtime.pdf.memory}), or null
     * @param which    the program the budget is for, in words ({@code validation}, {@code PDF})
     * @param bytes    the budget asked for
     * @param least    the least the engine can run in
     * @param engine   what needs the memory, in the engine's words ({@code QuickJS module})
     */
    public EngineMemoryFloorException(@Nullable String property, String which, long bytes, long least, String engine) {
        this(property, which, bytes, least, engine, null);
    }

    /** As above, with the engine's own refusal as the cause ({@link Engines#create}). */
    public EngineMemoryFloorException(@Nullable String property, String which, long bytes, long least, String engine,
                                      @Nullable Throwable cause) {
        super(property, "The " + which + " memory budget (" + bytes + " bytes) is below the " + engine + "'s initial memory, " + least
            + " bytes; the engine cannot run within it.", "Raise " + (property == null ? "the memory budget" : property) + " to at least "
            + least + " bytes, or choose another engine.", cause);
        this.bytes = bytes;
        this.least = least;
    }

    /** The budget asked for. */
    public long bytes() {
        return bytes;
    }

    /** The least the engine can run in. */
    public long least() {
        return least;
    }
}
