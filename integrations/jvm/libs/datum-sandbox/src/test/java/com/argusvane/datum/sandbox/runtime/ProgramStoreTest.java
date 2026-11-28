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
        assertThat(loaded.sandboxAbi()).isEqualTo("1.0.0");
        assertThat(loaded.pdfAbi()).isEqualTo("1.0.0");
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
        assertThat(loaded.pdfAbi()).isEqualTo("1.0.0");
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
            p -> p.files.remove(ProgramStore.BASE + "programs.json"),
            p -> p.files.remove(ProgramStore.PINS),
            p -> p.pins("{"),
            p -> p.pins(Programs.describe("1.0.0", "/* another build */", Programs.PDF, Programs.FREEZE)));
        for (Consumer<Programs> damage : damages) {
            Programs programs = Programs.packaged();
            damage.accept(programs);
            String fromLoad = refusal(() -> programs.store().load());
            String fromVerify = refusal(() -> ProgramStore.verify(packagedFiles(programs), programs.files.get(ProgramStore.MANIFEST),
                programs.files.get(ProgramStore.PINS)));
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
        String described = new String(programs.files.get(ProgramStore.MANIFEST), StandardCharsets.UTF_8);
        programs.put("programs.json", "{" + described.substring(described.indexOf("\"files\"")));
        ProgramStore.Programs loaded = programs.store().load();
        assertThat(loaded.sandboxAbi()).isEqualTo(SandboxAbi.MIN);
        assertThat(loaded.pdfAbi()).isEqualTo(PdfAbi.MIN);
        ProgramStore.Verified verified = ProgramStore.verify(packagedFiles(programs), programs.files.get(ProgramStore.MANIFEST),
            programs.files.get(ProgramStore.PINS));
        assertThat(verified.sandboxAbi()).as("the build check reports what the description says").isNull();
    }

    /** No description, or one that does not list a packaged file, is no check at all: the start is refused. */
    @Test
    void aMissingDescriptionOrAnUnlistedPackagedFileIsRefused() {
        Programs none = Programs.packaged();
        none.files.remove(ProgramStore.MANIFEST);
        assertThatThrownBy(() -> none.store().load()).isInstanceOf(ProgramUnavailableException.class)
            .hasMessageContaining(ProgramStore.MANIFEST + " is not on the classpath");
        for (String unlisted : new String[] {"datum-sandbox-program.js", "freeze-intrinsics.js", "datum-pdf-program.js"}) {
            Programs programs = Programs.packaged();
            programs.put("programs.json", programs.text(ProgramStore.MANIFEST).replace("\"" + unlisted + "\"", "\"another-file.js\""));
            assertThat(programs.text(ProgramStore.MANIFEST)).doesNotContain(unlisted);
            assertThatThrownBy(() -> programs.store().load()).as(unlisted).isInstanceOf(ProgramUnavailableException.class)
                .hasMessageContaining(unlisted + " is not listed in " + ProgramStore.MANIFEST);
        }
    }

    /** An override is listed nowhere by design: only the packaged freeze snippet must be, and the ABI probe proves the override. */
    @Test
    void anOverrideNeedsNoListingButTheFreezeSnippetDoes() {
        Programs programs = Programs.packaged();
        programs.files.remove(ProgramStore.BASE + "datum-sandbox-program.js");
        programs.files.remove(ProgramStore.BASE + "datum-pdf-program.js");
        String onlyFreeze = "{\"files\":{\"freeze-intrinsics.js\":\"" + com.argusvane.datum.core.canonical.CanonicalJson.sha256Hex(Programs.FREEZE) + "\"}}";
        programs.put("programs.json", onlyFreeze);
        programs.pins(onlyFreeze);
        ProgramStore store = new ProgramStore(programs.lookup(),
            com.argusvane.datum.core.io.ResourceHandle.of("byte array", "/* mine */".getBytes(StandardCharsets.UTF_8)), null);
        ProgramStore.Programs loaded = store.load();
        assertThat(new String(loaded.sandbox().bytes(), StandardCharsets.UTF_8)).isEqualTo("/* mine */");
        assertThat(loaded.hasPdf()).isFalse();
        programs.put("programs.json", "{\"files\":{}}");
        assertThatThrownBy(store::load).isInstanceOf(ProgramUnavailableException.class)
            .hasMessageContaining("freeze-intrinsics.js is not listed");
    }

    /**
     * The pins are datum-sandbox's own copy of the build's sha256s: a datum-programs from another build, its files and
     * its description consistent with each other, is refused; and so is a datum-sandbox that carries none.
     */
    @Test
    void aDatumProgramsFromAnotherBuildOrNoPinsIsRefused() {
        Programs other = Programs.packaged();
        other.pins(Programs.describe("1.0.0", "/* the sandbox program of another build */", Programs.PDF, Programs.FREEZE));
        assertThatThrownBy(() -> other.store().load()).isInstanceOf(ProgramUnavailableException.class)
            .hasMessageContaining("datum-sandbox-program.js does not have the sha256 this datum-sandbox was built with")
            .hasMessageContaining(ProgramStore.PINS);
        Programs freeze = Programs.packaged();
        freeze.pins(Programs.describe("1.0.0", Programs.SANDBOX, Programs.PDF, "/* another freeze */"));
        assertThatThrownBy(() -> freeze.store().load()).isInstanceOf(ProgramUnavailableException.class)
            .hasMessageContaining("freeze-intrinsics.js does not have the sha256 this datum-sandbox was built with");
        Programs unpinned = Programs.packaged();
        unpinned.files.remove(ProgramStore.PINS);
        assertThatThrownBy(() -> unpinned.store().load()).isInstanceOf(ProgramUnavailableException.class)
            .hasMessageContaining(ProgramStore.PINS + " is not in datum-sandbox");
        Programs damaged = Programs.packaged();
        damaged.pins("{");
        assertThatThrownBy(() -> damaged.store().load()).isInstanceOf(ProgramUnavailableException.class)
            .hasMessageContaining(ProgramStore.PINS + " is not JSON");
    }

    /**
     * The real classpath: datum-programs' files, its programs.json and the pins the build put in this module all agree, and
     * the build-time check reads the pins from datum-sandbox itself.
     */
    @Test
    void theBuildsOwnProgramsPassTheirPins() throws Exception {
        ClassLoader loader = ProgramStore.class.getClassLoader();
        assertThat(loader.getResource(ProgramStore.PINS)).as("the build copies the pins into datum-sandbox").isNotNull();
        ProgramStore.Programs loaded = new ProgramStore(loader, null, null).load();
        assertThat(loaded.sandbox().sha256()).hasSize(64);
        Map<String, byte[]> files = new LinkedHashMap<>();
        for (String name : new String[] {"freeze-intrinsics.js", "datum-sandbox-program.js"}) {
            try (java.io.InputStream in = loader.getResourceAsStream(ProgramStore.BASE + name)) {
                files.put(name, in.readAllBytes());
            }
        }
        byte[] manifest;
        try (java.io.InputStream in = loader.getResourceAsStream(ProgramStore.MANIFEST)) {
            manifest = in.readAllBytes();
        }
        assertThat(ProgramStore.verify(files, manifest).checked()).containsOnlyKeys("freeze-intrinsics.js", "datum-sandbox-program.js");
        files.put("datum-sandbox-program.js", "/* not it */".getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(() -> ProgramStore.verify(files, manifest)).isInstanceOf(ProgramUnavailableException.class);
    }

    private static Map<String, byte[]> packagedFiles(Programs programs) {
        Map<String, byte[]> files = new LinkedHashMap<>();
        programs.files.forEach((name, bytes) -> {
            if (name.startsWith(ProgramStore.BASE) && !name.equals(ProgramStore.MANIFEST)) {
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
            if (name.startsWith(ProgramStore.BASE) && !name.equals(ProgramStore.MANIFEST)) {
                files.put(name.substring(ProgramStore.BASE.length()), bytes);
            }
        });
        byte[] manifest = programs.files.get(ProgramStore.MANIFEST);
        byte[] pins = programs.files.get(ProgramStore.PINS);
        ProgramStore.Verified verified = ProgramStore.verify(files, manifest, pins);
        assertThat(verified.sandboxAbi()).isEqualTo("1.0.0");
        assertThat(verified.pdfAbi()).isEqualTo("1.0.0");
        assertThat(verified.checked()).containsKeys("freeze-intrinsics.js", "datum-sandbox-program.js", "datum-pdf-program.js");
        assertThatThrownBy(() -> ProgramStore.verify(files, null, pins)).as("no description is no check")
            .isInstanceOf(ProgramUnavailableException.class).hasMessageContaining("is not on the classpath");
        assertThatThrownBy(() -> ProgramStore.verify(files, manifest, null)).as("no pins is no check")
            .isInstanceOf(ProgramUnavailableException.class).hasMessageContaining("is not in datum-sandbox");

        Map<String, byte[]> damaged = new LinkedHashMap<>(files);
        damaged.put("datum-pdf-program.js", "/* not it */".getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(() -> ProgramStore.verify(damaged, manifest, pins)).isInstanceOf(ProgramUnavailableException.class)
            .hasMessageContaining("datum-pdf-program.js does not have the sha256");
        assertThatThrownBy(() -> ProgramStore.verify(files, "{".getBytes(StandardCharsets.UTF_8), pins)).isInstanceOf(ProgramUnavailableException.class)
            .hasMessageContaining("is not JSON");
    }
}
