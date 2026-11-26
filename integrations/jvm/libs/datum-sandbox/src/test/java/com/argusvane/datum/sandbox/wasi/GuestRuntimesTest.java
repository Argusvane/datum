package com.argusvane.datum.sandbox.wasi;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowableOfType;

import java.io.IOException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Finding the engines through {@link java.util.ServiceLoader} and choosing one by id: an unknown or
 * unavailable id is refused with the provider's reason and every id found, two providers of one id are refused, and a
 * broken entry never hides the others.
 */
class GuestRuntimesTest {

    private static final String SERVICES = "META-INF/services/" + GuestRuntimeProvider.class.getName();

    @TempDir
    Path dir;

    /** A provider that answers with the given id and availability. */
    abstract static class Stub implements GuestRuntimeProvider {

        @Override
        public GuestRuntime create(EngineLimits limits, EngineSettings settings) {
            return run -> RunOutput.exited(0, null, null);
        }
    }

    public static final class Alpha extends Stub {
        @Override
        public String id() {
            return "alpha";
        }

        @Override
        public Availability availability() {
            return Availability.available("runs natively");
        }
    }

    public static final class Beta extends Stub {
        @Override
        public String id() {
            return "beta";
        }

        @Override
        public Availability availability() {
            return Availability.unavailable("no native code for this platform");
        }
    }

    public static final class AlphaAgain extends Stub {
        @Override
        public String id() {
            return "alpha";
        }

        @Override
        public Availability availability() {
            return Availability.available("");
        }
    }

    public static final class Throwing extends Stub {
        @Override
        public String id() {
            return "throwing";
        }

        @Override
        public Availability availability() {
            throw new IllegalStateException("probe exploded");
        }
    }

    public static final class BadId extends Stub {
        @Override
        public String id() {
            return "Not An Id";
        }

        @Override
        public Availability availability() {
            return Availability.available("");
        }
    }

    /** A class loader whose META-INF/services lists these providers (one per line, as a services file does). */
    private ClassLoader loader(String... providers) throws IOException {
        Path services = dir.resolve(SERVICES);
        Files.createDirectories(services.getParent());
        Files.writeString(services, String.join("\n", providers) + "\n");
        return new URLClassLoader(new URL[] {dir.toUri().toURL()}, getClass().getClassLoader());
    }

    @Test
    void anIdSelectsItsProviderTrimmedAndInAnyCase() throws IOException {
        ClassLoader loader = loader(Alpha.class.getName(), Beta.class.getName());
        assertThat(GuestRuntimes.select("alpha", loader)).isInstanceOf(Alpha.class);
        assertThat(GuestRuntimes.select(" Alpha ", loader)).isInstanceOf(Alpha.class);
        assertThat(GuestRuntimes.discover(loader)).extracting(GuestRuntimes.Found::id).containsExactly("alpha", "beta");
    }

    @Test
    void anUnknownIdIsRefusedNamingEveryEngineFound() throws IOException {
        EngineSelectionException e = catchThrowableOfType(EngineSelectionException.class,
            () -> GuestRuntimes.select("nope", loader(Alpha.class.getName(), Beta.class.getName())));
        assertThat(e).isNotNull();
        assertThat(e.getMessage()).contains("\"nope\"").contains("alpha (available)").contains("beta (unavailable)");
        assertThat(e.requested()).isEqualTo("nope");
        assertThat(e.found()).hasSize(2);
        assertThatThrownBy(() -> GuestRuntimes.select("  ", loader(Alpha.class.getName())))
            .isInstanceOf(EngineSelectionException.class).hasMessageContaining("No engine id was given");
    }

    @Test
    void anUnavailableEngineIsRefusedWithItsReason() throws IOException {
        assertThatThrownBy(() -> GuestRuntimes.select("beta", loader(Alpha.class.getName(), Beta.class.getName())))
            .isInstanceOf(EngineSelectionException.class)
            .hasMessageContaining("\"beta\" is not available here: no native code for this platform")
            .hasMessageContaining("alpha (available)");
    }

    @Test
    void twoProvidersOfOneIdAreRefusedNotPickedByClassPathOrder() throws IOException {
        assertThatThrownBy(() -> GuestRuntimes.select("alpha", loader(Alpha.class.getName(), AlphaAgain.class.getName())))
            .isInstanceOf(EngineSelectionException.class)
            .hasMessageContaining(Alpha.class.getName()).hasMessageContaining(AlphaAgain.class.getName());
    }

    @Test
    void aBrokenEntryIsReportedAndNeverHidesTheOthers() throws IOException {
        ClassLoader loader = loader("com.argusvane.datum.no.SuchProvider", Throwing.class.getName(), BadId.class.getName(),
            Alpha.class.getName());
        List<GuestRuntimes.Found> found = GuestRuntimes.discover(loader);
        assertThat(found).hasSize(4);
        assertThat(found.get(0).usable()).isFalse();
        assertThat(found.get(1).id()).isEqualTo("throwing");
        assertThat(found.get(1).availability().isAvailable()).as("an availability that throws is unavailable").isFalse();
        assertThat(found.get(2).usable()).as("an id outside the pattern is broken").isFalse();
        assertThat(GuestRuntimes.select("alpha", loader)).isInstanceOf(Alpha.class);
        assertThatThrownBy(() -> GuestRuntimes.select("throwing", loader)).isInstanceOf(EngineSelectionException.class)
            .hasMessageContaining("probe exploded");
        assertThatThrownBy(() -> GuestRuntimes.select("nope", loader)).isInstanceOf(EngineSelectionException.class)
            .hasMessageContaining("could not be loaded").hasMessageContaining("SuchProvider");
    }

    /**
     * The walk's bound counts consecutive failures (a spinning iterator), not all of them: a good entry resets it, so an
     * engine listed after more broken entries than the bound in total is still found.
     */
    @Test
    void theBoundOnBrokenEntriesCountsOnlyConsecutiveOnes() throws IOException {
        List<String> entries = new java.util.ArrayList<>();
        for (int i = 0; i < 40; i++) {
            entries.add("com.argusvane.datum.no.Missing" + i);
        }
        entries.add(Alpha.class.getName());
        for (int i = 40; i < 80; i++) {
            entries.add("com.argusvane.datum.no.Missing" + i);
        }
        entries.add(Beta.class.getName());
        ClassLoader loader = loader(entries.toArray(String[]::new));
        assertThat(GuestRuntimes.discover(loader)).hasSize(82).filteredOn(GuestRuntimes.Found::usable)
            .extracting(GuestRuntimes.Found::id).containsExactly("alpha", "beta");
        assertThatThrownBy(() -> GuestRuntimes.select("beta", loader)).isInstanceOf(EngineSelectionException.class)
            .hasMessageContaining("\"beta\" is not available here");
    }

    @Test
    void withNoEngineAtAllTheRefusalNamesTheEngineModule() throws IOException {
        assertThatThrownBy(() -> GuestRuntimes.select("endive", loader()))
            .isInstanceOf(EngineSelectionException.class)
            .hasMessageContaining("engines found: none").hasMessageContaining("datum-sandbox-endive");
    }
}
