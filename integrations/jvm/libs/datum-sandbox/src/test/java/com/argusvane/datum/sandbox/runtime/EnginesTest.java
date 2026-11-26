package com.argusvane.datum.sandbox.runtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.wasi.EngineConfigurationException;
import com.argusvane.datum.sandbox.wasi.EngineLimits;
import com.argusvane.datum.sandbox.wasi.EngineSettings;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.wasi.GuestRuntimeProvider;
import com.argusvane.datum.sandbox.wasi.GuestUnavailableException;
import com.argusvane.datum.sandbox.wasi.MemoryFloorException;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

/**
 * The lifecycle's side of an engine's creation: the limits it is handed, and its refusals as the
 * ones a host prints, with the property, the problem and the action the Spring failure analyzer shows, word for word.
 */
class EnginesTest {

    private static final long LEAST = 1_179_648;

    /** A provider whose create() is the given function of the limits it was handed. */
    private static GuestRuntimeProvider provider(Function<EngineLimits, GuestRuntime> create) {
        return new GuestRuntimeProvider() {
            @Override
            public String id() {
                return "stub";
            }

            @Override
            public Availability availability() {
                return Availability.available("");
            }

            @Override
            public GuestRuntime create(EngineLimits limits, EngineSettings settings) {
                return create.apply(limits);
            }
        };
    }

    /** A provider that holds the least budget to {@link #LEAST}, as Endive holds it to the module's initial memory. */
    private static final GuestRuntimeProvider FLOORED = provider(limits -> {
        if (limits.minMemoryBytes() < LEAST) {
            throw new MemoryFloorException(limits.minMemoryBytes(), LEAST, "QuickJS module");
        }
        return run -> RunOutput.exited(0, null, null);
    });

    @Test
    void theProviderIsHandedTheSmallerAndTheLargerOfTheTwoBudgetsAndTheSettings() {
        ProgramLimits limits = ProgramLimits.builder().validationMemory(64L << 20).pdfMemory(512L << 20).build();
        assertThat(Engines.limits(limits)).isEqualTo(new EngineLimits(64L << 20, 512L << 20));
        assertThat(Engines.limits(ProgramLimits.builder().validationMemory(1024L << 20).pdfMemory(32L << 20).build()))
            .isEqualTo(new EngineLimits(32L << 20, 1024L << 20));
        AtomicReference<EngineLimits> seen = new AtomicReference<>();
        GuestRuntime made = run -> RunOutput.exited(0, null, null);
        assertThat(Engines.create(provider(given -> {
            seen.set(given);
            return made;
        }), limits, new EngineSettings(Duration.ofSeconds(2), 3))).isSameAs(made);
        assertThat(seen.get()).isEqualTo(new EngineLimits(64L << 20, 512L << 20));
        assertThatThrownBy(() -> Engines.create(provider(given -> null), limits, EngineSettings.defaults()))
            .isInstanceOf(NullPointerException.class);
    }

    @Test
    void aFloorUnderTheValidationBudgetNamesItsPropertyFirst() {
        // Both budgets are under the floor: the validation budget is named, as Endive checked it first.
        ProgramLimits limits = ProgramLimits.builder().validationMemory(4L << 20).pdfMemory(32L << 20).build();
        assertThat(limits.validationMemory()).isEqualTo(4L << 20);
        MemoryFloorException engine = new MemoryFloorException(4L << 20, 64L << 20, "QuickJS module");
        DatumConfigurationException refusal = Engines.floor(engine, limits);
        EngineMemoryFloorException expected = new EngineMemoryFloorException("datum.runtime.validation.memory", "validation",
            limits.validationMemory(), 64L << 20, "QuickJS module");
        assertThat(refusal).isInstanceOfSatisfying(EngineMemoryFloorException.class, floor -> {
            assertThat(floor.property()).isEqualTo("datum.runtime.validation.memory");
            assertThat(floor.bytes()).isEqualTo(limits.validationMemory());
            assertThat(floor.least()).isEqualTo(64L << 20);
            assertThat(floor.getMessage()).isEqualTo(expected.getMessage());
            assertThat(floor.action()).isEqualTo(expected.action());
            assertThat(floor.getCause()).isSameAs(engine);
        });
    }

    @Test
    void aFloorUnderOnlyThePdfBudgetNamesThePdfProperty() {
        ProgramLimits limits = ProgramLimits.builder().validationMemory(512L << 20).pdfMemory(64L << 20).build();
        DatumConfigurationException refusal = Engines.floor(new MemoryFloorException(64L << 20, 128L << 20, "QuickJS module"), limits);
        assertThat(refusal).isInstanceOfSatisfying(EngineMemoryFloorException.class, floor -> {
            assertThat(floor.property()).isEqualTo("datum.runtime.pdf.memory");
            assertThat(floor.bytes()).isEqualTo(64L << 20);
            assertThat(floor.getMessage()).isEqualTo("The PDF memory budget (" + (64L << 20) + " bytes) is below the QuickJS module's "
                + "initial memory, " + (128L << 20) + " bytes; the engine cannot run within it.");
            assertThat(floor.action()).isEqualTo("Raise datum.runtime.pdf.memory to at least " + (128L << 20)
                + " bytes, or choose another engine.");
        });
        // A floor no budget is below (an engine's own sum): its words, no property.
        DatumConfigurationException odd = Engines.floor(new MemoryFloorException(1, 2, "x"), limits);
        assertThat(odd).isNotInstanceOf(EngineMemoryFloorException.class);
        assertThat(odd.property()).isNull();
    }

    @Test
    void createPassesALimitTheEngineHonoursAndTranslatesEveryRefusal() {
        assertThat(Engines.create(FLOORED, ProgramLimits.defaults(), EngineSettings.defaults())).isNotNull();
        EngineConfigurationException other = new EngineConfigurationException("The engine cannot address 4 GiB.");
        assertThatThrownBy(() -> Engines.create(provider(limits -> {
            throw other;
        }), ProgramLimits.defaults(), EngineSettings.defaults())).isInstanceOfSatisfying(DatumConfigurationException.class, e -> {
            assertThat(e.property()).isNull();
            assertThat(e.getMessage()).isEqualTo(other.getMessage());
            assertThat(e.getCause()).isSameAs(other);
        });
        GuestUnavailableException broken = new GuestUnavailableException("The precompiled module cannot be loaded.");
        assertThatThrownBy(() -> Engines.create(provider(limits -> {
            throw broken;
        }), ProgramLimits.defaults(), EngineSettings.defaults())).isInstanceOf(ProgramUnavailableException.class)
            .hasMessage(broken.getMessage()).hasCause(broken);
        MemoryFloorException floor = new MemoryFloorException(4L << 20, 8L << 20, "QuickJS module");
        assertThatThrownBy(() -> Engines.create(provider(limits -> {
            throw floor;
        }), ProgramLimits.builder().validationMemory(4L << 20).build(), EngineSettings.defaults())).isInstanceOf(EngineMemoryFloorException.class)
            .isInstanceOf(IllegalArgumentException.class).hasCause(floor);
    }
}
