package com.argusvane.datum.webauthn;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.canonical.Jcs;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import org.erdtman.jcs.JsonCanonicalizer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.JsonNodeFactory;

/**
 * RFC 8785 (JCS), the text a passkey signs, over {@link SignedText#canonicalize}, which is java-json-canonicalization.
 *
 * <p>The vectors are the engine's shared ones ({@code engine/tests/fixtures/jcs-vectors.json}) and the shared RFC 8785
 * ones ({@code integrations/shared/fixtures/jcs-vectors.json}: RFC 8785's examples and the repository's tricky keys),
 * both copied into {@code datum-fixtures/} by the asset build. datum-core's {@link Jcs} is not what a signature is checked over: it
 * spells some doubles just above a power of two with 17 digits where ECMAScript takes a shorter one (2^-24,
 * 2^89), so the numbers below pin the library's spelling against node's.
 */
class JcsTest {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    static Stream<Arguments> vectors() {
        List<Arguments> cases = new ArrayList<>();
        for (String[] file : List.of(new String[] {"jcs-vectors.json", "engine: "}, new String[] {"jcs-vectors-rfc8785.json", ""})) {
            try (InputStream in = JcsTest.class.getResourceAsStream("/datum-fixtures/" + file[0])) {
                assertThat(in).as("Run ./mvnw -N generate-resources in integrations/jvm: datum-fixtures/" + file[0] + " is missing.").isNotNull();
                for (JsonNode vector : JSON.readTree(in)) {
                    cases.add(Arguments.of(file[1] + vector.get("name").asString(), vector.get("input").asString(), vector.get("canonical").asString()));
                }
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        }
        return cases.stream();
    }

    /** Each vector's input canonicalizes to its canonical text, which is a fixed point. */
    @ParameterizedTest(name = "{0}")
    @MethodSource("vectors")
    void vector(String name, String input, String canonical) throws IOException {
        assertThat(SignedText.canonicalize(JSON.readTree(input))).isEqualTo(canonical);
        assertThat(SignedText.canonicalize(JSON.readTree(canonical))).isEqualTo(canonical);
        // The library on the text itself agrees (no Jackson round trip in between).
        assertThat(new JsonCanonicalizer(input).getEncodedString()).isEqualTo(canonical);
    }

    /**
     * Doubles just above a power of two, written as ECMAScript's Number::toString writes them (the spellings
     * are node's {@code JSON.stringify}): the engine signs these, so the server must rebuild them byte for byte.
     */
    @ParameterizedTest(name = "{0}")
    @MethodSource("powersOfTwo")
    void numbersNextToAPowerOfTwo(double value, String ecmascript) throws IOException {
        assertThat(SignedText.canonicalize(JsonNodeFactory.instance.arrayNode().add(value))).isEqualTo("[" + ecmascript + "]");
        assertThat(SignedText.canonicalize(JSON.readTree("[" + ecmascript + "]"))).isEqualTo("[" + ecmascript + "]");
        assertThat(new JsonCanonicalizer("[" + value + "]").getEncodedString()).isEqualTo("[" + ecmascript + "]");
    }

    static Stream<Arguments> powersOfTwo() {
        return Stream.of(
            Arguments.of(Math.scalb(1.0, -24), "5.960464477539063e-8"),
            Arguments.of(Math.scalb(1.0, -44), "5.684341886080802e-14"),
            Arguments.of(Math.scalb(1.0, 89), "6.189700196426902e+26"),
            Arguments.of(6.617444900424222e-24, "6.617444900424222e-24"));
    }

    /** Both vector files are here, so the engine, the module and this host agree. */
    @Test
    void bothVectorFilesAreRead() {
        List<String> names = vectors().map(arguments -> (String) arguments.get()[0]).toList();
        assertThat(names).anyMatch(name -> name.startsWith("engine: "));
        assertThat(names.size()).isGreaterThanOrEqualTo(10);
    }

    /** Key order is UTF-16 code units, integer-like keys included. */
    @Test
    void keyOrder() {
        assertThat(SignedText.canonicalize(JSON.readTree("{\"a_b\":6,\"a\":4,\"2\":2,\"B\":3,\"10\":1,\"a-b\":5}")))
            .isEqualTo("{\"10\":1,\"2\":2,\"B\":3,\"a\":4,\"a-b\":5,\"a_b\":6}");
        assertThat(SignedText.canonicalize(JsonNodeFactory.instance.objectNode())).isEqualTo("{}");
        assertThat(SignedText.canonicalize(JsonNodeFactory.instance.arrayNode())).isEqualTo("[]");
        // A lone value (the values scope of an envelope without values signs null).
        assertThat(SignedText.canonicalize(JSON.readTree("null"))).isEqualTo("null");
        assertThat(SignedText.canonicalize(JSON.readTree("\"a\\u00e9\\n\""))).isEqualTo("\"a\u00e9\\n\"");
        assertThat(SignedText.canonicalize(JSON.readTree("1.50"))).isEqualTo("1.5");
        assertThat(SignedText.canonicalize(JSON.readTree("true"))).isEqualTo("true");
        assertThat(SignedText.text(JSON.readTree("{\"submission\":{}}"), "values", null)).isEqualTo("null");
    }

    /**
     * What has no JCS form is refused, never written some other way: a number that is not finite (Jackson
     * would write NaN as the string "NaN"), an integer or decimal past a double's range, a lone surrogate, a
     * node that is not JSON (binary, a Java object).
     */
    @Test
    void refusesWhatHasNoCanonicalForm() {
        for (JsonNode bad : List.of(
            JsonNodeFactory.instance.arrayNode().add(Double.POSITIVE_INFINITY),
            JsonNodeFactory.instance.arrayNode().add(Double.NaN),
            JsonNodeFactory.instance.arrayNode().add(Float.NEGATIVE_INFINITY),
            JSON.readTree("[1" + "0".repeat(400) + "]"),
            JsonNodeFactory.instance.arrayNode().add(new java.math.BigDecimal("1E+400")),
            JsonNodeFactory.instance.arrayNode().add("\ud800"),
            JsonNodeFactory.instance.objectNode().put("\udc00", 1),
            JsonNodeFactory.instance.arrayNode().add(new byte[] {1, 2}),
            JsonNodeFactory.instance.arrayNode().addPOJO(new Object()))) {
            assertThatThrownBy(() -> SignedText.canonicalize(bad)).as(bad.toString()).isInstanceOf(IllegalArgumentException.class);
        }
    }

    /** Integers beyond 2^53 are written as the double a browser reads. */
    @Test
    void largeIntegers() {
        assertThat(SignedText.canonicalize(JSON.readTree("9007199254740992"))).isEqualTo("9007199254740992");
        assertThat(SignedText.canonicalize(JSON.readTree("1234567890123456789"))).isEqualTo("1234567890123456800");
        assertThat(SignedText.canonicalize(JSON.readTree("[-0, 0.0, 1e21, 1e-7, 0.1]"))).isEqualTo("[0,0,1e+21,1e-7,0.1]");
    }
}
