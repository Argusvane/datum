package com.argusvane.datum.sandbox.protocol;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.ProgramUnavailableException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * The run.js, as text: the fixed order, one string literal per rule source, the labels, the PDF line and the
 * freeze snippet's resource. What the script does on a real QuickJS (capture, delete, freeze, the markers, a source
 * evaluated as written) is datum-sandbox-tck's: SandboxHardeningContract and RuntimeContract.
 */
class RunScriptTest {

    /** A stand-in for the generated snippet, over more than one line (the real one is datum-programs'). */
    private static final String FREEZE = "  (function () {\n    \"use strict\";\n\n    Object.freeze(Object.prototype);\n  })();";
    private static final RunScript SCRIPTS = new RunScript(FREEZE);

    /** The fixed order: capture < delete < freeze < started < register. */
    @Test
    void globalsAreRemovedAndTheKernelFrozenBeforeAnyRuleIsRegistered() {
        for (RunScript.Entry entry : RunScript.Entry.values()) {
            String script = SCRIPTS.sandbox(List.of(
                new RuleModule("a", "1", "({ validators: [] })"),
                new RuleModule("b", "2", "({ validators: [] })")), entry);
            int read = script.indexOf("std.in.readAsString()");
            int captureEntry = script.indexOf(entry == RunScript.Entry.RUN ? "var entry = globalThis.__datum_run;" : "var entry = globalThis.__datum_inspect;");
            int captureRegister = script.indexOf("var register = globalThis.__datum_register;");
            int delete = script.indexOf("delete globalThis[name]");
            int freeze = script.indexOf(FREEZE);
            int startedMark = script.indexOf("print(mark(\"started\"))");
            int register = script.indexOf("register(evaluate(");
            assertThat(List.of(read, captureEntry, captureRegister, delete, freeze, startedMark, register)).doesNotContain(-1);
            assertThat(read).isLessThan(captureEntry);
            assertThat(captureEntry).isLessThan(delete);
            assertThat(captureRegister).isLessThan(delete);
            assertThat(delete).isLessThan(freeze);
            assertThat(freeze).isLessThan(startedMark);
            assertThat(startedMark).isLessThan(register);
            assertThat(script.split("std\\.in\\.readAsString\\(\\)", -1)).hasSize(2);
            for (String name : RunScript.REMOVED_GLOBALS) {
                assertThat(script.substring(delete - 200, delete)).as(name).contains("\"" + name + "\"");
            }
            assertThat(script.split("register\\(evaluate\\(", -1)).hasSize(3);
            assertThat(script).doesNotContain("__datum_register(");
            // Nothing but the run's markers is printed, and only after the run.
            assertThat(prints(script)).containsExactly("mark(\"started\")", "mark(\"begin\")", "answer", "mark(\"end\")");
            assertThat(script).contains("  var mark = function (kind) { return \"@@datum:\" + nonce + \":\" + kind + \"@@\"; };");
            assertThat(script).endsWith("})(std, print, eval);\n");
        }
    }

    @Test
    void inspectScriptCallsInspectAndRegistersNothing() {
        String script = SCRIPTS.sandbox(List.of(), RunScript.Entry.INSPECT);
        assertThat(script).contains("var entry = globalThis.__datum_inspect;");
        assertThat(script).doesNotContain("register(evaluate(");
    }

    /** A rule source cannot break out of its string, nor its comment, nor see a local. */
    @Test
    void ruleSourceIsOneStringLiteral() throws Exception {
        String hostile = "1); print('forged'); (\n//   é \"quoted\" \\ back";
        String script = SCRIPTS.sandbox(List.of(new RuleModule("x", "1", hostile)), RunScript.Entry.RUN);
        List<String> lines = script.lines().filter(line -> line.contains("register(evaluate(")).toList();
        assertThat(lines).hasSize(1);
        String literal = lines.get(0).substring("  register(evaluate(".length(), lines.get(0).length() - "));".length());
        assertThat(StrictJson.decode(literal).stringValue()).isEqualTo("(\n" + hostile + "\n)");
        assertThat(script).doesNotContain(" ");
    }

    /**
     * The script is ASCII: every character past it is an escape, so a lone surrogate, U+2028 or an astral character
     * reaches evaluate exactly as the source has it.
     */
    @Test
    void theScriptIsAsciiAndASourceReachesEvaluateUnchanged() throws Exception {
        String source = "({ m: 'a\ud800b\udc00c\uD83D\uDE00 \u2028 \u00e9 \u0001\u001f\u007f/<>&\t\b\f\r\n\"\\' })";
        String script = SCRIPTS.sandbox(List.of(new RuleModule("x", "1", source)), RunScript.Entry.RUN);
        assertThat(script.chars().allMatch(c -> c < 0x80)).as("only ASCII in the script").isTrue();
        String line = script.lines().filter(l -> l.contains("register(evaluate(")).findFirst().orElseThrow();
        String literal = line.substring("  register(evaluate(".length(), line.length() - "));".length());
        assertThat(tools.jackson.databind.json.JsonMapper.builder().build().readTree(literal).stringValue()).isEqualTo("(\n" + source + "\n)");
    }

    @Test
    void ruleLabelsKeepOnlyAsciiWordCharacters() {
        assertThat(RunScript.commentLabel("acme/rules x@2.0.0-beta+é")).isEqualTo("acmerulesx@2.0.0-beta");
        assertThat(RunScript.commentLabel("a*/ evil @1")).isEqualTo("aevil@1");
    }

    @Test
    void argvAndThePdfScript() {
        assertThat(RunScript.argv(Program.Kind.SANDBOX)).containsExactly("qjs", "--std", "-I", "/app/datum-sandbox-program.js", "/app/run.js");
        assertThat(RunScript.argv(Program.Kind.PDF)).containsExactly("qjs", "--std", "-I", "/app/datum-pdf-program.js", "/app/run.js");
        assertThat(RunScript.PDF).isEqualTo("__datum_pdf(std.in.readAsString()).then((json) => print(json));\n");
    }

    /** The snippet comes from datum-programs' resource; a trailing line break is not a line of the script. */
    @Test
    void freezeSnippetFromTheClasspath() throws Exception {
        URL stub = Path.of(RunScriptTest.class.getClassLoader().getResource("sandbox/stub-programs/").toURI()).toUri().toURL();
        try (URLClassLoader loader = new URLClassLoader(new URL[] {stub}, null)) {
            RunScript fromResource = RunScript.fromClasspath(loader);
            assertThat(fromResource.freezeSnippet()).startsWith("/* stub freeze").endsWith("})();");
            String script = fromResource.sandbox(List.of(), RunScript.Entry.RUN);
            int delete = script.indexOf("delete globalThis[name]");
            int freeze = script.indexOf("Object.freeze(Object.prototype)");
            assertThat(freeze).isGreaterThan(delete).isLessThan(script.indexOf("print(mark(\"started\"))"));
            assertThat(script).doesNotContain("})();\n\n");
        }
        assertThat(new RunScript(FREEZE + "\n").sandbox(List.of(), RunScript.Entry.RUN)).isEqualTo(SCRIPTS.sandbox(List.of(), RunScript.Entry.RUN));
        try (URLClassLoader empty = new URLClassLoader(new URL[0], null)) {
            assertThatThrownBy(() -> RunScript.fromClasspath(empty)).isInstanceOf(ProgramUnavailableException.class)
                .hasMessageContaining(RunScript.FREEZE_RESOURCE);
        }
        assertThatThrownBy(() -> new RunScript(" \n")).isInstanceOf(ProgramUnavailableException.class);
    }

    private static List<String> prints(String script) {
        List<String> found = new ArrayList<>();
        Matcher m = Pattern.compile("^\\s*print\\((.+)\\);$", Pattern.MULTILINE).matcher(script);
        while (m.find()) {
            found.add(m.group(1));
        }
        return found;
    }
}
