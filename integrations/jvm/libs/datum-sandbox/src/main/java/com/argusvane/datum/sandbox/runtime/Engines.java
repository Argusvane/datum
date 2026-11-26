package com.argusvane.datum.sandbox.runtime;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.protocol.ProgramRunner;
import com.argusvane.datum.sandbox.wasi.EngineConfigurationException;
import com.argusvane.datum.sandbox.wasi.EngineLimits;
import com.argusvane.datum.sandbox.wasi.EngineSettings;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.wasi.GuestRuntimeProvider;
import com.argusvane.datum.sandbox.wasi.GuestRuntimes;
import com.argusvane.datum.sandbox.wasi.GuestUnavailableException;
import com.argusvane.datum.sandbox.wasi.MemoryFloorException;
import java.util.Objects;

/**
 * How the lifecycle creates an engine from a provider: the provider is handed the
 * {@link EngineLimits} the program limits imply, and what it refuses with is translated here, once, into the refusal a
 * host prints. A memory floor names the budget's property ({@link EngineMemoryFloorException}, the property and the fix in
 * the Spring failure analyzer's Description and Action), other limits it cannot honour are a
 * {@link DatumConfigurationException}, and an engine that cannot be made is a {@code ProgramUnavailableException}, as a
 * run that cannot start is ({@link ProgramRunner#unavailable}).
 */
public final class Engines {

    /** The property of {@link ProgramLimits#validationMemory()}, which a memory floor refusal names. */
    public static final String VALIDATION_MEMORY = "datum.runtime.validation.memory";

    /** The property of {@link ProgramLimits#pdfMemory()}, which a memory floor refusal names. */
    public static final String PDF_MEMORY = "datum.runtime.pdf.memory";

    private Engines() {
    }

    /** The memory budgets the programs' runs will be given: the smaller and the larger of the validation and PDF budgets. */
    public static EngineLimits limits(ProgramLimits limits) {
        Objects.requireNonNull(limits, "limits");
        return new EngineLimits(Math.min(limits.validationMemory(), limits.pdfMemory()),
            Math.max(limits.validationMemory(), limits.pdfMemory()));
    }

    /**
     * The provider's runtime for these limits and settings.
     *
     * @throws EngineMemoryFloorException when a budget is below the engine's own initial memory: the validation budget's
     *     property when that one is below it, else the PDF budget's
     * @throws DatumConfigurationException when the engine refuses the limits for another reason
     * @throws com.argusvane.datum.core.ProgramUnavailableException when the engine cannot be made here
     */
    public static GuestRuntime create(GuestRuntimeProvider provider, ProgramLimits limits, EngineSettings settings) {
        Objects.requireNonNull(provider, "provider");
        Objects.requireNonNull(limits, "limits");
        Objects.requireNonNull(settings, "settings");
        try {
            return Objects.requireNonNull(provider.create(limits(limits), settings), "The engine provider created no runtime.");
        } catch (MemoryFloorException e) {
            throw floor(e, limits);
        } catch (EngineConfigurationException e) {
            throw new DatumConfigurationException(null, e.getMessage(), null, e);
        } catch (GuestUnavailableException e) {
            throw ProgramRunner.unavailable(e);
        }
    }

    /**
     * The engine the settings name, found on the loader's class path and made for these limits: the framework-free route to a
     * runtime ({@code GuestRuntimes.select} then {@link #create}), as a host with no binding takes it.
     *
     * @throws com.argusvane.datum.sandbox.wasi.EngineSelectionException when no engine has the id or it is unavailable here
     * @throws EngineMemoryFloorException when a budget is below the engine's own initial memory
     */
    public static GuestRuntime select(SandboxSettings settings, ProgramLimits limits, ClassLoader loader) {
        Objects.requireNonNull(settings, "settings");
        return create(GuestRuntimes.select(settings.engine().id(), loader), limits, settings.engine().engineSettings());
    }

    /**
     * The engine's floor as the budget it fails: the validation budget first, then the PDF budget, as the engine checked
     * them when it was handed the limits themselves; each names its property and the least the engine can run in.
     */
    static DatumConfigurationException floor(MemoryFloorException e, ProgramLimits limits) {
        if (limits.validationMemory() < e.least()) {
            return new EngineMemoryFloorException(VALIDATION_MEMORY, "validation", limits.validationMemory(), e.least(), e.engine(), e);
        }
        if (limits.pdfMemory() < e.least()) {
            return new EngineMemoryFloorException(PDF_MEMORY, "PDF", limits.pdfMemory(), e.least(), e.engine(), e);
        }
        // An engine whose floor no budget is below: its own words, with no property to name.
        return new DatumConfigurationException(null, e.getMessage(), null, e);
    }
}
