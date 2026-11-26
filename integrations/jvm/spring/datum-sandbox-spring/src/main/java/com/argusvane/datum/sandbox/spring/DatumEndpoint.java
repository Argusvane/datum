package com.argusvane.datum.sandbox.spring;

import com.argusvane.datum.sandbox.runtime.DatumSandbox;
import com.argusvane.datum.sandbox.runtime.SandboxStatus;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.actuate.endpoint.annotation.Endpoint;
import org.springframework.boot.actuate.endpoint.annotation.ReadOperation;
import org.springframework.boot.actuate.endpoint.annotation.WriteOperation;

/**
 * The {@code datum} actuator endpoint ({@code /actuator/datum}): the runtime's state on a read, and a recheck on
 * a POST. The recheck reloads the program overrides, asks both programs for their ABI again and warms up, so an
 * operator who fixed a program file (or a native library) brings a DOWN runtime back without a restart
 * ({@link DatumSandbox#recheck()}; it never throws, it reports).
 *
 * <p>Exposure is the application's choice ({@code management.endpoints.web.exposure.include=datum}); a read
 * answers states, ABIs, the engine's id, version and mode, and slot counts only. The free-text reason a start failed
 * and the engine's notes (why a runner was passed over) can hold file paths or native library messages, so only the
 * recheck (a write, which actuator security normally guards harder) returns them.
 *
 * <p>The read also answers {@code settings}: the effective-settings report as JSON ({@code DatumSandbox#report()}), every key with its value and source, the engine, the programs' sha256 and ABI, and the trace and capture state.
 * By the same rule it leaves out what can name a place on this host: the capture directory and a program override's location
 * show as {@code "(not shown)"}, and the engine's notes and where the trace and the capture go are omitted; the start log has
 * them all.
 */
@Endpoint(id = "datum")
public class DatumEndpoint {

    private final DatumSandbox runtime;

    public DatumEndpoint(DatumSandbox runtime) {
        this.runtime = runtime;
    }

    /** The runtime now. */
    @ReadOperation
    public Map<String, Object> status() {
        Map<String, Object> out = describe(runtime.status());
        out.remove("reason");
        out.remove("engineNotes");
        out.put("settings", runtime.report().toJson(true));
        return out;
    }

    /** Proves the runtime again and answers the state after. */
    @WriteOperation
    public Map<String, Object> recheck() {
        return describe(runtime.recheck());
    }

    private Map<String, Object> describe(SandboxStatus status) {
        // stuckRuns and strayRuns are in the status details (health shows them too).
        return new LinkedHashMap<>(status.details());
    }
}
