package com.argusvane.datum.sandbox.tck;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.sandbox.protocol.AbiProbe;
import com.argusvane.datum.sandbox.protocol.PdfAbi;
import com.argusvane.datum.sandbox.protocol.PdfProgram;
import com.argusvane.datum.sandbox.protocol.ProgramLimits;
import com.argusvane.datum.sandbox.protocol.ProgramRunner;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * The PDF program on the engine renders the parity documents byte for byte as the Node kernel does: the requests of
 * {@code packages/pdf-kernel/tests/kernel-parity-documents.test.ts} (the fixed env, the whole DejaVu pack) through
 * {@link PdfProgram}, each output's sha256 equal to {@code hashes.json}. Prints the render times with the engine's mode.
 *
 * <p>Implement it only for a runtime that is not on bytecode ({@code engineInfo().isBytecode()} false: the lifecycle runs no
 * PDF program there); the contract fails, never skips, when the runtime says otherwise, so a regression in what the engine
 * reports cannot hide the renders.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
public interface PdfRenderContract extends RuntimeUnderTest {

    /** The DejaVu pack in the font loader's order: id, family, weight, style, file. */
    List<String[]> PACK = List.of(
        new String[] {"dejavu-sans", "sans-serif", "400", "normal", "DejaVuSans.ttf"},
        new String[] {"dejavu-sans-bold", "sans-serif", "700", "normal", "DejaVuSans-Bold.ttf"},
        new String[] {"dejavu-sans-oblique", "sans-serif", "400", "italic", "DejaVuSans-Oblique.ttf"},
        new String[] {"dejavu-serif", "serif", "400", "normal", "DejaVuSerif.ttf"},
        new String[] {"dejavu-serif-bold", "serif", "700", "normal", "DejaVuSerif-Bold.ttf"},
        new String[] {"dejavu-mono", "monospace", "400", "normal", "DejaVuSansMono.ttf"},
        new String[] {"dejavu-mono-bold", "monospace", "700", "normal", "DejaVuSansMono-Bold.ttf"});

    @Test
    default void theParityDocumentsRenderToTheirPinnedHashes() {
        assertThat(runtime().engineInfo().isBytecode()).as("the runtime under this contract is not on bytecode, where the PDF program does not "
            + "run").isFalse();
        // A parity test, not a speed test: 60 s per render rather than the production 15 s, so a loaded CI runner (JFFI
        // renders took 10-12.5 s under contention) cannot fail it with BUDGET. The budget itself is
        // proved by the sandbox budget tests; the printed times stay as information.
        PdfProgram pdf = new PdfProgram(ProgramRunner.on(runtime()), RuntimeTckAssets.pdfProgram(), ProgramLimits.builder().pdfSeconds(60).build(), new AbiProbe());
        assertThat(pdf.capabilities().kernelVersion()).as("the capabilities answer names the kernel's version").isNotEmpty();
        JsonNode hashes = RuntimeTckAssets.fixture("documents/hashes.json");
        ArrayNode fonts = fonts();
        List<String> times = new ArrayList<>();
        for (Map.Entry<String, JsonNode> entry : hashes.properties()) {
            String theme = entry.getKey();
            ObjectNode request = JsonNodeFactory.instance.objectNode();
            request.put("abi", PdfAbi.MIN);
            request.put("op", "render");
            request.set("document", RuntimeTckAssets.fixture("documents/" + theme + ".json"));
            request.set("fonts", fonts);
            ObjectNode env = request.putObject("env");
            env.put("createdAt", "2026-09-05T10:11:12.000Z");
            env.put("documentId", "pdf-theme-sheet");
            env.put("producer", "Datum pdf-theme-sheet");
            long started = System.nanoTime();
            ObjectNode answer = pdf.call(request);
            times.add(String.format("%s %.0f ms", theme, (System.nanoTime() - started) / 1e6));
            byte[] bytes = Base64.getDecoder().decode(answer.path("bytes").asString());
            assertThat(RuntimeTckAssets.sha256(bytes)).as(theme).isEqualTo(entry.getValue().asString());
        }
        System.out.printf("[datum-sandbox-tck] PDF render (parity documents), engine %s (%s) on Java %d: %s%n", runtime().engineInfo().id(),
            runtime().engineInfo().mode(), Runtime.version().feature(), String.join(", ", times));
    }

    private static ArrayNode fonts() {
        ArrayNode fonts = JsonNodeFactory.instance.arrayNode();
        for (String[] font : PACK) {
            ObjectNode entry = fonts.addObject();
            entry.put("id", font[0]);
            entry.put("family", font[1]);
            entry.put("weight", Integer.parseInt(font[2]));
            entry.put("style", font[3]);
            entry.put("data", Base64.getEncoder().encodeToString(RuntimeTckAssets.font(font[4])));
        }
        return fonts;
    }
}
