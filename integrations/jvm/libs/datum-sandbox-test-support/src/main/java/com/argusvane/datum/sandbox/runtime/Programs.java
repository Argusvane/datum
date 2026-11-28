package com.argusvane.datum.sandbox.runtime;

import com.argusvane.datum.core.canonical.CanonicalJson;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Function;

/** An in-memory datum-programs classpath for the program store. */
final class Programs {

    static final String SANDBOX = "/* sandbox program */";
    static final String PDF = "/* pdf program */";
    static final String FREEZE = "/* freeze */\n";

    final Map<String, byte[]> files = new HashMap<>();

    /** The three files, a programs.json that describes them and datum-sandbox's pins of the same three. */
    static Programs packaged() {
        Programs programs = new Programs();
        programs.put("datum-sandbox-program.js", SANDBOX);
        programs.put("datum-pdf-program.js", PDF);
        programs.put("freeze-intrinsics.js", FREEZE);
        programs.manifest(SANDBOX, PDF, FREEZE);
        return programs;
    }

    void put(String name, String text) {
        files.put(ProgramStore.BASE + name, text.getBytes(StandardCharsets.UTF_8));
    }

    void manifest(String sandbox, String pdf, String freeze) {
        manifest("2.14.0", sandbox, pdf, freeze);
    }

    /** A programs.json naming this sandbox ABI, and the same text as datum-sandbox's pins (one build made both). */
    void manifest(String sandboxAbi, String sandbox, String pdf, String freeze) {
        String text = describe(sandboxAbi, sandbox, pdf, freeze);
        put("programs.json", text);
        pins(text);
    }

    /** datum-sandbox's pins ({@link ProgramStore#PINS}), as given. */
    void pins(String text) {
        files.put(ProgramStore.PINS, text.getBytes(StandardCharsets.UTF_8));
    }

    /** A programs.json text over these three files. */
    static String describe(String sandboxAbi, String sandbox, String pdf, String freeze) {
        return "{\"sandboxAbi\":\"" + sandboxAbi + "\",\"pdfAbi\":\"4.0.0\",\"files\":{"
            + "\"datum-sandbox-program.js\":\"" + CanonicalJson.sha256Hex(sandbox) + "\","
            + "\"datum-pdf-program.js\":\"" + CanonicalJson.sha256Hex(pdf) + "\","
            + "\"freeze-intrinsics.js\":\"" + CanonicalJson.sha256Hex(freeze) + "\"}}";
    }

    /** A file's text, by its classpath name. */
    String text(String name) {
        return new String(files.get(name), StandardCharsets.UTF_8);
    }

    Function<String, InputStream> lookup() {
        return name -> files.containsKey(name) ? new ByteArrayInputStream(files.get(name)) : null;
    }

    ProgramStore store() {
        return new ProgramStore(lookup(), null, null);
    }
}
