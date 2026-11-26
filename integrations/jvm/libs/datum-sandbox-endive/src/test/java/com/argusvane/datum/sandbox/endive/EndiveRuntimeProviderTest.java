package com.argusvane.datum.sandbox.endive;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.runtime.Engines;
import com.argusvane.datum.sandbox.wasi.EngineLimits;
import com.argusvane.datum.sandbox.wasi.EngineSelectionException;
import com.argusvane.datum.sandbox.wasi.EngineSettings;
import com.argusvane.datum.sandbox.wasi.GuestRuntime;
import com.argusvane.datum.sandbox.wasi.GuestRuntimeProvider;
import com.argusvane.datum.sandbox.wasi.GuestRuntimes;
import com.argusvane.datum.sandbox.wasi.MemoryFloorException;
import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Endive as the {@code endive} engine: found through {@link java.util.ServiceLoader} from this jar's
 * {@code META-INF/services}, available here, created with the settings and limits it is given, and named in the refusal
 * of any other id.
 */
class EndiveRuntimeProviderTest {

    private final ClassLoader loader = getClass().getClassLoader();

    @Test
    void theJarRegistersExactlyTheEndiveEngine() {
        List<GuestRuntimes.Found> found = GuestRuntimes.discover(loader);
        assertThat(found).extracting(GuestRuntimes.Found::id).containsExactly("endive");
        assertThat(found.get(0).providerClass()).isEqualTo(EndiveRuntimeProvider.class.getName());
        assertThat(found.get(0).availability().isAvailable()).isTrue();
        assertThat(GuestRuntimes.select("endive", loader)).isInstanceOf(EndiveRuntimeProvider.class);
    }

    @Test
    void anyOtherIdIsRefusedNamingEndiveAsTheOnlyEngine() {
        assertThatThrownBy(() -> GuestRuntimes.select("nope", loader)).isInstanceOf(EngineSelectionException.class)
            .hasMessageContaining("\"nope\"").hasMessageContaining("engines found: endive (available).");
    }

    @Test
    void createMakesARuntimeWithTheSettingsGivenAndTheSameRunner() throws Exception {
        GuestRuntimeProvider provider = GuestRuntimes.select("endive", loader);
        GuestRuntime runtime = provider.create(Engines.limits(ProgramLimits.defaults()), new EngineSettings(Duration.ofSeconds(2), 3));
        try {
            assertThat(runtime).isInstanceOf(EndiveGuestRuntime.class);
            assertThat(runtime.engineInfo().id()).isEqualTo("endive");
            assertThat(runtime.engineInfo().mode()).isEqualTo(((EndiveGuestRuntime) runtime).nativeProvider());
            assertThat(runtime.engineInfo().isBytecode()).isEqualTo(!((EndiveGuestRuntime) runtime).isNative());
            assertThat(runtime.engineInfo().version()).isEqualTo("1.2.0");
            assertThat(runtime.strayRuns()).isZero();
        } finally {
            ((AutoCloseable) runtime).close();
        }
    }

    @Test
    void aMemoryBudgetBelowTheModulesOwnIsRefusedAtStart() {
        long least = EndiveGuestRuntime.minimumMemoryBytes();
        EndiveRuntimeProvider.requireMemory(least);
        assertThatThrownBy(() -> EndiveRuntimeProvider.requireMemory(least - 1)).isInstanceOf(MemoryFloorException.class)
            .hasMessageContaining("QuickJS module").hasMessageContaining(String.valueOf(least));
        // At creation, before any runtime is made: the least budget of the limits is what is held to the floor.
        assertThatThrownBy(() -> new EndiveRuntimeProvider().create(new EngineLimits(least - 1, 1L << 30), EngineSettings.defaults()))
            .isInstanceOf(MemoryFloorException.class);
    }

    /**
     * The floor is a typed refusal with the numbers, in the engine's words; which property it names is the lifecycle's
     * ({@code Engines.create}: datum-sandbox's EnginesTest holds the property, the action and the validation-first order).
     */
    @Test
    void theMemoryFloorRefusalIsATypedConfigurationFailureNamingTheBudgetsProperty() {
        long least = EndiveGuestRuntime.minimumMemoryBytes();
        assertThatThrownBy(() -> EndiveRuntimeProvider.requireMemory(least - 1))
            .isInstanceOfSatisfying(MemoryFloorException.class, refusal -> {
                assertThat(refusal.bytes()).isEqualTo(least - 1);
                assertThat(refusal.least()).isEqualTo(least);
                assertThat(refusal.engine()).isEqualTo("QuickJS module");
            });
        assertThatThrownBy(() -> EndiveRuntimeProvider.requireMemory(1)).isInstanceOf(com.argusvane.datum.sandbox.wasi.EngineConfigurationException.class);
        assertThat(ProgramLimits.VALIDATION_MEMORY.min()).as("the protocol's floor is above the module's own memory").isGreaterThanOrEqualTo(least);
    }
}
