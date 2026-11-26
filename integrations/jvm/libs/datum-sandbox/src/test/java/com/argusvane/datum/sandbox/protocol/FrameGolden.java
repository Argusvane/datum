package com.argusvane.datum.sandbox.protocol;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * Writes {@code sandbox/framed-golden.json}: 29 stdouts and what {@link Frame} answers for each (the framed answer and
 * whether the run's begin and end markers were there). The golden is Datum's own: a change to it is a change of the
 * frame rule and is reviewed as one, never regenerated to make a test pass.
 *
 * <p>From {@code integrations/jvm} after a test compile of datum-core:
 * {@code java -cp "libs/datum-core/target/classes:libs/datum-core/target/test-classes:$(cat cp.txt)"
 * com.argusvane.datum.sandbox.protocol.FrameGolden > libs/datum-sandbox/src/test/resources/sandbox/framed-golden.json}
 * (cp.txt from {@code ./mvnw -q -pl libs/datum-core dependency:build-classpath -Dmdep.outputFile=cp.txt}).
 */
public final class FrameGolden {

    static final String NONCE = "0123456789abcdef0123456789abcdef";

    private FrameGolden() {
    }

    /** The stdouts, by label, in the golden's order. */
    static Map<String, String> inputs() {
        String n = NONCE;
        String s = Frame.marker(n, "started");
        String b = Frame.marker(n, "begin");
        String e = Frame.marker(n, "end");
        String o = Frame.marker("f".repeat(32), "begin");
        String oe = Frame.marker("f".repeat(32), "end");
        String f = s + "\n" + b + "\n{\"errors\":[]}\n" + e + "\n";
        Map<String, String> in = new LinkedHashMap<>();
        in.put("plain", f);
        in.put("crlf", s + "\r\n" + b + "\r\n{\"errors\":[]}\r\n" + e + "\r\n");
        in.put("tabs vt nul around", "\t\u000B\0" + s + "\0\u000B" + b + " \t{}\t " + e + "\0\u000B\t\n");
        in.put("json whitespace around", "\t \r\n" + s + " \r\n\t" + b + " \t{}\t\r\n" + e + "\r\n \t");
        in.put("formfeed before", "\f" + f);
        in.put("formfeed after", f + "\f");
        in.put("formfeed in answer edges", s + "\n" + b + "\f{}\f" + e + "\n");
        in.put("nbsp after", f + " ");
        in.put("empty answer", s + "\n" + b + "\n" + e + "\n");
        in.put("answer whitespace only", s + "\n" + b + "\n \t\n" + e + "\n");
        in.put("no newline at all", s + b + "{}" + e);
        in.put("answer holds other nonce markers", s + "\n" + b + "\n" + o + "{}" + oe + "\n" + e + "\n");
        in.put("answer holds a started marker", s + "\n" + b + "\n" + s + "\n" + e + "\n");
        in.put("other nonce only", o + "\n{}\n" + oe + "\n");
        in.put("second frame", f + f);
        in.put("end before begin", s + "\n" + e + "\n{}\n" + b + "\n");
        in.put("started after begin", b + "\n" + s + "\n{}\n" + e + "\n");
        in.put("started after end", b + "\n{}\n" + e + "\n" + s + "\n");
        in.put("missing started", b + "\n{}\n" + e + "\n");
        in.put("missing end", s + "\n" + b + "\n{}\n");
        in.put("stray after", f + "INJECTED\n");
        in.put("stray before", "INJECTED\n" + f);
        in.put("stray between", s + "\nX\n" + b + "\n{}\n" + e + "\n");
        in.put("glued to end", s + "\n" + b + "\n{}\n" + e + "x");
        in.put("empty", "");
        in.put("only started", s + "\n");
        in.put("utf8 answer", s + "\n" + b + "\n{\"m\":\"é😀\"}\n" + e + "\n");
        in.put("answer inner newlines kept", s + "\n" + b + "\n  {\n\"errors\": []\n}  \n" + e + "\n");
        in.put("marker overlap attempt", s + "\n" + b + "\n@@datum:" + n + ":end@@datum:" + n + ":end@@\n");
        return in;
    }

    /** The golden as Frame answers it today. */
    static ObjectNode golden() {
        JsonMapper json = StrictJson.mapper();
        ObjectNode root = json.createObjectNode();
        root.put("nonce", NONCE);
        ArrayNode cases = root.putArray("cases");
        Base64.Encoder base64 = Base64.getEncoder();
        inputs().forEach((label, stdout) -> {
            byte[] bytes = stdout.getBytes(StandardCharsets.UTF_8);
            byte[] framed = Frame.framed(bytes, NONCE);
            ObjectNode row = cases.addObject();
            row.put("label", label);
            row.put("stdoutBase64", base64.encodeToString(bytes));
            if (framed == null) {
                row.putNull("framed");
            } else {
                row.put("framed", base64.encodeToString(framed));
            }
            row.put("stray", Frame.hasStrayOutput(bytes, NONCE));
        });
        return root;
    }

    public static void main(String[] args) {
        System.out.println(StrictJson.mapper().writerWithDefaultPrettyPrinter().writeValueAsString(golden()));
    }
}
