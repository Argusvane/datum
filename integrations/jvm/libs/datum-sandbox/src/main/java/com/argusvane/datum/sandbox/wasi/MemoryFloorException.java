package com.argusvane.datum.sandbox.wasi;

/**
 * The least memory budget a run may be given ({@link EngineLimits#minMemoryBytes()}) is below what the engine needs to
 * start the module at all (its own initial memory), so no run could honour it. The engine says how much it
 * needs and in its own words what; the layer above knows which of its budgets that is and names its property.
 */
public final class MemoryFloorException extends EngineConfigurationException {

    private static final long serialVersionUID = 1L;

    private final long bytes;
    private final long least;
    private final String engine;

    /**
     * @param bytes  the least budget asked for
     * @param least  the least the engine can run in
     * @param engine what needs the memory, in the engine's words ({@code QuickJS module})
     */
    public MemoryFloorException(long bytes, long least, String engine) {
        super("A memory budget of " + bytes + " bytes is below the " + engine + "'s initial memory, " + least
            + " bytes; the engine cannot run within it.");
        this.bytes = bytes;
        this.least = least;
        this.engine = engine;
    }

    /** The least budget asked for. */
    public long bytes() {
        return bytes;
    }

    /** The least the engine can run in. */
    public long least() {
        return least;
    }

    /** What needs the memory, in the engine's words. */
    public String engine() {
        return engine;
    }
}
