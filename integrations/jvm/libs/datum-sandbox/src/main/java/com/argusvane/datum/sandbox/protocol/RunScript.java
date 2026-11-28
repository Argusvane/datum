package com.argusvane.datum.sandbox.protocol;

import com.argusvane.datum.core.ProgramUnavailableException;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import tools.jackson.core.json.JsonWriteFeature;
import tools.jackson.databind.json.JsonMapper;

/**
 * The {@code run.js} a run executes.
 *
 * <p>One function, so what it holds is out of the rule modules' reach. It reads stdin (the run's nonce, a
 * line, then the input) and keeps print, the entry point and register in locals; removes the host's and the
 * engine's extra globals ({@link #REMOVED_GLOBALS}) from the global scope, failing the run if one stays; freezes the kernel's globals and the intrinsics (the
 * {@code freeze-intrinsics.js} resource, FREEZE_INTRINSICS_SNIPPET of
 * {@code packages/quickjs-wasm-host/src/sandbox-program.ts}); prints the "started" marker; evaluates each rule module as a global
 * expression and registers it; calls the entry point; and prints the answer between the begin and end
 * markers. A rule module therefore cannot reach stdin, print or std by name, nor print a verdict without the
 * nonce; it can still import {@code qjs:std} and {@code qjs:os}, so it is host-trusted code, and the strict frame ({@link Frame}) refuses anything it prints.
 *
 * <p>The order inside the function is the hardening: the entry point and the registration function are captured
 * before the globals are removed (so a module that replaces {@code __datum_run} changes nothing), the globals are
 * removed and the kernel frozen before the started marker, and every module is registered after it.
 * datum-sandbox-tck's {@code SandboxHardeningContract} checks that behaviour on a real QuickJS.
 *
 * <p>The PDF program registers no untrusted module, so its script is one line with no nonce frame ({@link #PDF}).
 */
public final class RunScript {

    /**
     * Writes a rule's source as a JSON string literal (valid JavaScript): every character past ASCII as a
     * {@code \}{@code u} escape, so the script is ASCII and every source character, a lone surrogate included,
     * reaches {@code evaluate} unchanged, and U+2028 or U+2029 never end a line of the script.
     */
    private static final JsonMapper LITERALS = JsonMapper.builder().enable(JsonWriteFeature.ESCAPE_NON_ASCII).build();

    /** Where datum-programs puts the freeze snippet, generated from the TypeScript (never pasted). */
    public static final String FREEZE_RESOURCE = "META-INF/datum/programs/freeze-intrinsics.js";

    /**
     * The PDF program's {@code run.js}: QuickJS runs the pending jobs once the script has run, and the program's
     * only timers are microtasks, so the promise settles before qjs exits.
     */
    public static final String PDF = "__datum_pdf(std.in.readAsString()).then((json) => print(json));\n";

    /**
     * The globals run.js removes before any module is evaluated, in the script's order: what qjs adds for its own
     * scripts ({@code std}, {@code os}, {@code print}, {@code console}, {@code scriptArgs}, {@code bjson}, {@code gc},
     * {@code argv0}, {@code execArgv}) and what quickjs-ng adds that Bellard QuickJS, the page's engine, has not
     * ({@code performance}, {@code queueMicrotask}, {@code navigator}, {@code atob}, {@code btoa}, {@code DOMException}),
     * so a rule module reaches the same globals on the server as in the browser. The standard ones quickjs-ng also has
     * ({@code DisposableStack}, {@code AsyncDisposableStack}, {@code SuppressedError}) stay, frozen with the other
     * intrinsics. The run script uses none of them but the {@code std} and {@code print} it captured first. The Python
     * host's run script removes the same list.
     */
    public static final List<String> REMOVED_GLOBALS = List.of("std", "os", "print", "console", "performance", "scriptArgs",
        "bjson", "queueMicrotask", "gc", "navigator", "argv0", "execArgv", "atob", "btoa", "DOMException");

    /** Which entry point a sandbox run calls. */
    public enum Entry {
        /** {@code __datum_run}: a validation. */
        RUN("run"),
        /** {@code __datum_inspect}: a question about a definition (ABI 2.8.0). */
        INSPECT("inspect");

        private final String word;

        Entry(String word) {
            this.word = word;
        }
    }

    private final String freezeSnippet;

    /**
     * A script builder over a freeze snippet.
     *
     * @param freezeSnippet FREEZE_INTRINSICS_SNIPPET's text; trailing line breaks are dropped (the generated
     *     file may end with one, which is not a line of the script), nothing else is touched
     */
    public RunScript(String freezeSnippet) {
        Objects.requireNonNull(freezeSnippet, "freezeSnippet");
        String text = freezeSnippet;
        while (text.endsWith("\n") || text.endsWith("\r")) {
            text = text.substring(0, text.length() - 1);
        }
        if (text.isBlank()) {
            // Not optional: without the freeze a module could rebind a kernel function for the rest of the run.
            throw new ProgramUnavailableException("The freeze snippet is empty: rebuild the program assets (npm run jvm:assets).");
        }
        this.freezeSnippet = text;
    }

    /**
     * The builder over the freeze snippet datum-programs ships ({@link #FREEZE_RESOURCE}).
     *
     * @throws ProgramUnavailableException when the resource is missing or unreadable: no run may start
     *     without the freeze
     */
    public static RunScript fromClasspath(ClassLoader loader) {
        ClassLoader from = loader != null ? loader : RunScript.class.getClassLoader();
        try (InputStream in = from.getResourceAsStream(FREEZE_RESOURCE)) {
            if (in == null) {
                throw new ProgramUnavailableException("The freeze snippet " + FREEZE_RESOURCE
                    + " is not on the classpath: add datum-programs (npm run jvm:assets builds it).");
            }
            return new RunScript(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new ProgramUnavailableException("The freeze snippet " + FREEZE_RESOURCE + " cannot be read.", e);
        }
    }

    /** The freeze snippet this builder inserts. */
    public String freezeSnippet() {
        return freezeSnippet;
    }

    /**
     * The sandbox {@code run.js} for these rule modules and this entry point.
     *
     * @param rules rule modules, registered in this order
     * @param entry the entry point called
     */
    public String sandbox(List<RuleModule> rules, Entry entry) {
        Objects.requireNonNull(entry, "entry");
        List<String> registrations = new ArrayList<>();
        for (RuleModule rule : rules == null ? List.<RuleModule>of() : rules) {
            registrations.add("  // " + commentLabel(rule.id() + "@" + rule.version()));
            // The parentheses make the source an expression, as it was when it was the argument of the
            // registration; the newlines keep a trailing line comment in it from swallowing the closing one.
            registrations.add("  register(evaluate(" + LITERALS.writeValueAsString("(\n" + rule.source() + "\n)") + "));");
        }
        List<String> lines = new ArrayList<>();
        lines.add("(function (std, print, evaluate) {");
        lines.add("  \"use strict\";");
        lines.add("  var raw = std.in.readAsString();");
        lines.add("  var nonce = raw.slice(0, 32);");
        lines.add("  if (raw.charAt(32) !== \"\\n\" || !/^[0-9a-f]{32}$/.test(nonce)) { throw new Error(\"no run nonce\"); }");
        lines.add("  var input = raw.slice(33);");
        lines.add("  var entry = globalThis.__datum_" + entry.word + ";");
        lines.add("  var register = globalThis.__datum_register;");
        lines.add("  if (typeof entry !== \"function\" || typeof register !== \"function\") { throw new Error(\"no sandbox program\"); }");
        lines.add("  [" + String.join(", ", REMOVED_GLOBALS.stream().map(name -> "\"" + name + "\"").toList()) + "].forEach(function (name) {");
        lines.add("    delete globalThis[name];");
        lines.add("    if (name in globalThis) { throw new Error(\"cannot remove \" + name); }");
        lines.add("  });");
        // The kernel and the intrinsics are read-only to the rule modules that are registered next.
        // Every line of the snippet, empty ones included: split with a negative limit.
        lines.addAll(List.of(freezeSnippet.split("\n", -1)));
        lines.add("  var mark = function (kind) { return \"@@datum:\" + nonce + \":\" + kind + \"@@\"; };");
        lines.add("  print(mark(\"started\"));");
        lines.addAll(registrations);
        lines.add("  var answer = entry(input);");
        lines.add("  print(mark(\"begin\"));");
        lines.add("  print(answer);");
        lines.add("  print(mark(\"end\"));");
        lines.add("})(std, print, eval);");
        return String.join("\n", lines) + "\n";
    }

    /**
     * The guest's arguments: {@code qjs --std -I /app/<program> /app/run.js}. {@code --std} gives run.js
     * {@code std} (which it then removes from the global scope); {@code -I} evaluates the program first.
     */
    public static List<String> argv(Program.Kind kind) {
        return List.of("qjs", "--std", "-I", kind.guestPath(), "/app/run.js");
    }

    /**
     * A rule's label in its comment line: ASCII letters, digits, underscore, {@code .}, {@code @} and {@code -}
     * only, so nothing in an id or a version can end the line comment or the script's line (a line terminator,
     * U+2028) and the label stays readable in a dump of run.js.
     */
    static String commentLabel(String label) {
        StringBuilder out = new StringBuilder(label.length());
        for (int i = 0; i < label.length(); i++) {
            char c = label.charAt(i);
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '.' || c == '@' || c == '-') {
                out.append(c);
            }
        }
        return out.toString();
    }
}
