package com.argusvane.datum.sandbox.wasi;

/**
 * Limits the engine cannot honour, refused when it is created ({@link GuestRuntimeProvider#create}) rather than on the
 * first run: no run could keep them. The layer above names the setting at fault (the Datum lifecycle turns it into a
 * {@code DatumConfigurationException} with the property and the fix). {@link MemoryFloorException} is the one an engine
 * here throws.
 */
public class EngineConfigurationException extends WasiException {

    private static final long serialVersionUID = 1L;

    public EngineConfigurationException(String message) {
        super(message);
    }

    public EngineConfigurationException(String message, Throwable cause) {
        super(message, cause);
    }
}
