package com.argusvane.datum.sandbox.endive;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.argusvane.datum.sandbox.wasi.Budget;
import com.argusvane.datum.sandbox.wasi.RunOutput;
import com.argusvane.datum.sandbox.wasi.Termination;
import com.argusvane.datum.sandbox.protocol.ProgramRunner;
import com.argusvane.datum.sandbox.tck.RuntimeTckAssets;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Both selector poms on one class path, as datum-spring-boot-starter-submissions ships them: Panama on Java 25+, JFFI
 * below it, and a run either way. On Java 17 this is the case where {@code Qjs.nativeProvider()} dies with an
 * {@code UnsupportedClassVersionError}; the runtime never asks it. Runs in the both-runners failsafe
 * execution on every JDK, and in panama-it.
 */
class SelectorsTogetherIT {

    @Test
    void bothRunnersOnTheClassPathPickTheOneThisJavaRuns() {
        ClassLoader loader = getClass().getClassLoader();
        assumeTrue(loader.getResource(Runner.PANAMA.providerClass().replace('.', '/') + ".class") != null,
            "only with the Panama runner on the class path");
        assertThat(loader.getResource(Runner.JFFI.providerClass().replace('.', '/') + ".class")).isNotNull();
        Runner expected = Runtime.version().feature() >= 25 ? Runner.PANAMA : Runner.JFFI;
        try (EndiveGuestRuntime runtime = new EndiveGuestRuntime()) {
            assertThat(runtime.nativeProvider()).isEqualTo(expected.id());
            if (expected == Runner.PANAMA && !Boolean.TRUE.equals(ProviderSelector.nativeAccessBeforeSelection())) {
                // This execution starts the JVM without --enable-native-access: the WARN naming the fix fires, although the
                // probe's restricted call has since made the JVM enable access for the module.
                assertThat(ProviderSelector.nativeAccessEnabled(ProviderSelector.class.getModule())).as("the JVM enabled it after its warning")
                    .isTrue();
                assertThat(EndiveGuestRuntime.nativeAccessWarned()).as("the native-access WARN was logged").isTrue();
            }
            RunOutput output = runtime.run(ProgramRunner.guestRun(RuntimeTckAssets.sandboxProgram(), "print('both');", List.of("qjs", "--std", "/app/run.js"),
                new byte[0], new Budget(30, 32L << 20, Budget.STDOUT_LIMIT, Budget.STDERR_LIMIT)));
            assertThat(output.termination()).isEqualTo(Termination.EXITED);
            assertThat(new String(output.stdout(), StandardCharsets.UTF_8)).isEqualTo("both\n");
        }
    }
}
