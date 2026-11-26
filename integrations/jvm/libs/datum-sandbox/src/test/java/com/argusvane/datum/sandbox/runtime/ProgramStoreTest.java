package com.argusvane.datum.sandbox.runtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.ProgramUnavailableException;
import com.argusvane.datum.sandbox.protocol.PdfAbi;
import com.argusvane.datum.sandbox.protocol.Program;
import com.argusvane.datum.sandbox.protocol.SandboxAbi;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;

class ProgramStoreTest {

    @Test
    void readsThePackagedProgramsCheckedAgainstProgramsJson() {
        ProgramStore.Programs loaded = Programs.packaged().store().load();
        assertThat(loaded.sandbox().kind()).isEqualTo(Program.Kind.SANDBOX);
        assertThat(new String(loaded.sandbox().bytes(), StandardCharsets.UTF_8)).isEqualTo(Programs.SANDBOX);
        assertThat(loaded.pdf().kind()).isEqualTo(Program.Kind.PDF);
        assertThat(loaded.freezeSnippet()).isEqualTo(Programs.FREEZE);
        assertThat(loaded.sandboxAbi()).isEqualTo("2.14.0");
        assertThat(loaded.pdfAbi()).isEqualTo("4.0.0");
        assertThat(loaded.pdfUnavailable()).isNull();
    }

    @Test
    void aPackagedFileThatDoesNotMatchItsHashIsRefused() {
        Programs programs = Programs.packaged();
        programs.put("datum-sandbox-program.js", "/* tampered */");
        assertThatThrownBy(() -> programs.store().load()).isInstanceOf(ProgramUnavailableException.class).hasMessageContaining("sha256");
        Programs freeze = Programs.packaged();
        freeze.put("freeze-intrinsics.js", "/* other */");
        assertThatThrownBy(() -> freeze.store().load()).isInstanceOf(ProgramUnavailableException.class).hasMessageContaining("freeze");
    }

    @Test
    void noSandboxProgramOrNoFreezeSnippetIsUnavailable() {
        Programs programs = Programs.packaged();
        programs.files.remove(ProgramStore.BASE + "datum-sandbox-program.js");
        assertThatThrownBy(() -> programs.store().load()).isInstanceOf(ProgramUnavailableException.class)
            .hasMessageContaining("datum.runtime.programs.sandbox");
        Programs noFreeze = Programs.packaged();
        noFreeze.files.remove(ProgramStore.BASE + "freeze-intrinsics.js");
        assertThatThrownBy(() -> noFreeze.store().load()).isInstanceOf(ProgramUnavailableException.class);
    }

    @Test
    void aMissingPdfProgramLeavesThePdfPathUnavailableOnly() {
        Programs programs = Programs.packaged();
        programs.files.remove(ProgramStore.BASE + "datum-pdf-program.js");
        ProgramStore.Programs loaded = programs.store().load();
        assertThat(loaded.hasPdf()).isFalse();
        assertThat(loaded.pdfUnavailable()).contains("not on the classpath");
    }

    @Test
    void anOverrideIsReadAsItIsAndAMissingOneIsUnavailable() {
        Programs programs = Programs.packaged();
        ProgramStore store = new ProgramStore(programs.lookup(),
            com.argusvane.datum.core.io.ResourceHandle.of("byte array", "/* mine */".getBytes(StandardCharsets.UTF_8)), null);
        ProgramStore.Programs loaded = store.load();
        assertThat(new String(loaded.sandbox().bytes(), StandardCharsets.UTF_8)).isEqualTo("/* mine */");
        assertThat(loaded.pdfAbi()).isEqualTo("4.0.0");
        ProgramStore missing = new ProgramStore(programs.lookup(),
            com.argusvane.datum.core.io.ResourceHandle.of(java.nio.file.Path.of("/no/such/datum-sandbox-program.js")), null);
        assertThatThrownBy(missing::load).isInstanceOf(ProgramUnavailableException.class).hasMessageContaining("does not exist");
    }

    /**
     * The start and a Quarkus build check would work one way (integrations/jvm/README.md "Libraries and bindings"): load() runs
     * its packaged-file checks through ProgramStore.verify, so for every damaged classpath the two refuse alike,
     * with the same message, and an intact one passes both.
     */
    @Test
    void loadAndVerifyRefuseTheSameDamage() {
        List<Consumer<Programs>> damages = List.of(
            p -> { },
            p -> p.put("datum-sandbox-program.js", "/* tampered */"),
            p -> p.put("datum-pdf-program.js", "/* tampered */"),
            p -> p.put("freeze-intrinsics.js", "/* tampered */"),
            p -> {
                p.put("freeze-intrinsics.js", "/* tampered */");
                p.put("datum-pdf-program.js", "/* tampered */");
            },
            p -> p.put("programs.json", "{"),
            p -> p.put("programs.json", "{\"files\":{}}"),
            p -> p.files.remove(ProgramStore.BASE + "programs.json"));
        for (Consumer<Programs> damage : damages) {
            Programs programs = Programs.packaged();
            damage.accept(programs);
            String fromLoad = refusal(() -> programs.store().load());
            String fromVerify = refusal(() -> ProgramStore.verify(packagedFiles(programs), programs.files.get(ProgramStore.MANIFEST)));
            assertThat(fromLoad).isEqualTo(fromVerify);
        }
    }

    @Test
    void aTamperedPdfProgramIsRefusedAtTheStart() {
        Programs programs = Programs.packaged();
        programs.put("datum-pdf-program.js", "/* tampered */");
        assertThatThrownBy(() -> programs.store().load()).isInstanceOf(ProgramUnavailableException.class)
            .hasMessageContaining("datum-pdf-program.js does not have the sha256");
    }

    @Test
    void anOverrideStillHasThePackagedFreezeSnippetChecked() {
        Programs programs = Programs.packaged();
        programs.put("freeze-intrinsics.js", "/* tampered */");
        ProgramStore store = new ProgramStore(programs.lookup(),
            com.argusvane.datum.core.io.ResourceHandle.of("byte array", "/* mine */".getBytes(StandardCharsets.UTF_8)), null);
        assertThatThrownBy(store::load).isInstanceOf(ProgramUnavailableException.class)
            .hasMessageContaining("freeze-intrinsics.js does not have the sha256");
    }

    @Test
    void aDescriptionWithoutAbisFallsBackToTheMinimumAtTheStartOnly() {
        Programs programs = Programs.packaged();
        programs.put("programs.json", "{\"files\":{}}");
        ProgramStore.Programs loaded = programs.store().load();
        assertThat(loaded.sandboxAbi()).isEqualTo(SandboxAbi.MIN);
        assertThat(loaded.pdfAbi()).isEqualTo(PdfAbi.MIN);
        ProgramStore.Verified verified = ProgramStore.verify(packagedFiles(programs), programs.files.get(ProgramStore.MANIFEST));
        assertThat(verified.sandboxAbi()).as("the build check reports what the description says").isNull();
    }

    private static Map<String, byte[]> packagedFiles(Programs programs) {
        Map<String, byte[]> files = new LinkedHashMap<>();
        programs.files.forEach((name, bytes) -> {
            if (!name.equals(ProgramStore.MANIFEST)) {
                files.put(name.substring(ProgramStore.BASE.length()), bytes);
            }
        });
        return files;
    }

    private static String refusal(Runnable call) {
        try {
            call.run();
            return null;
        } catch (ProgramUnavailableException e) {
            return e.getMessage();
        }
    }

    @Test
    void verifyChecksPackagedProgramsAgainstTheirDescription() {
        Programs programs = Programs.packaged();
        Map<String, byte[]> files = new LinkedHashMap<>();
        programs.files.forEach((name, bytes) -> {
            if (!name.equals(ProgramStore.MANIFEST)) {
                files.put(name.substring(ProgramStore.BASE.length()), bytes);
            }
        });
        byte[] manifest = programs.files.get(ProgramStore.MANIFEST);
        ProgramStore.Verified verified = ProgramStore.verify(files, manifest);
        assertThat(verified.sandboxAbi()).isEqualTo("2.14.0");
        assertThat(verified.pdfAbi()).isEqualTo("4.0.0");
        assertThat(verified.checked()).containsKeys("freeze-intrinsics.js", "datum-sandbox-program.js", "datum-pdf-program.js");
        assertThat(ProgramStore.verify(files, null).checked()).isEmpty();

        Map<String, byte[]> damaged = new LinkedHashMap<>(files);
        damaged.put("datum-pdf-program.js", "/* not it */".getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(() -> ProgramStore.verify(damaged, manifest)).isInstanceOf(ProgramUnavailableException.class)
            .hasMessageContaining("datum-pdf-program.js does not have the sha256");
        assertThatThrownBy(() -> ProgramStore.verify(files, "{".getBytes(StandardCharsets.UTF_8))).isInstanceOf(ProgramUnavailableException.class)
            .hasMessageContaining("is not JSON");
    }
}
