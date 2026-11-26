package com.argusvane.datum.core.canonical;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.core.RepoFixtures;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import tools.jackson.databind.JsonNode;

class CanonicalJsonTest {


    private static JsonNode parse(String json) {
        return RepoFixtures.MAPPER.readTree(json);
    }

    @TestFactory
    Stream<DynamicTest> theEngineAndCodeUnitFixturesAgree() {
        // canonical.json is written by the engine's own serializeCanonicalSubmission
        // (integrations/shared/scripts/canonical-fixtures.ts); a divergent case would mean the browser and the sandbox
        // digest different bytes. The Java port must match the code-unit order (the program's), never V8's localeCompare.
        JsonNode cases = RepoFixtures.fixture("canonical.json");
        return Stream.iterate(0, i -> i + 1).limit(cases.size()).map(i -> {
            JsonNode c = cases.get(i);
            return DynamicTest.dynamicTest(c.get("name").stringValue(), () -> {
                String ours = CanonicalJson.serialize(parse(c.get("input").stringValue()));
                assertThat(c.get("divergent").booleanValue()).isFalse();
                assertThat(ours).isEqualTo(c.get("codeUnit").stringValue());
                assertThat(ours).isEqualTo(c.get("engine").stringValue());
            });
        });
    }

    @TestFactory
    Stream<DynamicTest> theRfc8785VectorsUnderJcs() {
        return Stream.of("jcs-vectors-rfc8785.json", "jcs-vectors-engine.json").flatMap(file -> {
            JsonNode cases = RepoFixtures.fixture(file);
            return Stream.iterate(0, i -> i + 1).limit(cases.size()).map(i -> {
                JsonNode c = cases.get(i);
                return DynamicTest.dynamicTest(file + ": " + c.get("name").stringValue(),
                    () -> assertThat(Jcs.canonicalize(parse(c.get("input").stringValue()))).isEqualTo(c.get("canonical").stringValue()));
            });
        });
    }

    @Test
    void keysSortByUtf16CodeUnitNotByCollation() {
        // "B" < "a" in code units (ICU would put a first); an astral key (surrogate pair D83D) sorts before U+FFFD.
        assertThat(CanonicalJson.serialize(parse("{\"a\":1,\"B\":2,\"\uD83D\uDE00\":3,\"\uFFFD\":4}")))
            .isEqualTo("{\"B\":2,\"a\":1,\"\uD83D\uDE00\":3,\"\uFFFD\":4}");
    }

    @Test
    void arrayIndexKeysComeFirstInNumericOrder() {
        assertThat(CanonicalJson.serialize(parse("{\"b\":1,\"10\":1,\"2\":1,\"01\":1,\"a\":1}")))
            .isEqualTo("{\"2\":1,\"10\":1,\"01\":1,\"a\":1,\"b\":1}");
        assertThat(CanonicalJson.orderedKeys(List.of("4294967295", "4294967294", "x"))).containsExactly("4294967294", "4294967295", "x");
    }

    @Test
    void numbersFollowEcmaScript() {
        assertThat(CanonicalJson.serialize(parse("[0,-0,-0.0,1e21,1e-7,0.000001,1.5e300,123456789012345680000,0.1,5.0,-7,9007199254740993]")))
            .isEqualTo("[0,0,0,1e+21,1e-7,0.000001,1.5e+300,123456789012345680000,0.1,5,-7,9007199254740992]");
        assertThat(CanonicalJson.serialize(parse("[-9223372036854775808,9223372036854775807]")))
            .isEqualTo("[-9223372036854776000,9223372036854776000]");
        assertThat(CanonicalJson.number(1.0 / 3)).isEqualTo("0.3333333333333333");
        assertThat(CanonicalJson.number(Double.MIN_VALUE)).isEqualTo("5e-324");
        assertThat(CanonicalJson.number(Double.MAX_VALUE)).isEqualTo("1.7976931348623157e+308");
    }

    @Test
    void stringsEscapeLikeJsonStringify() {
        assertThat(CanonicalJson.serialize(parse("\"a\\u0001\\u001f\\n\\t\\\"\\\\/\\u007f\\u2028\"")))
            .isEqualTo("\"a\\u0001\\u001f\\n\\t\\\"\\\\/\u007f\u2028\"");
        assertThat(CanonicalJson.serialize(RepoFixtures.MAPPER.getNodeFactory().stringNode("\uD800x"))).isEqualTo("\"\\ud800x\"");
    }

    @Test
    void digestIsSha256HexOfTheCanonicalText() {
        assertThat(CanonicalJson.digest(parse("{}"))).isEqualTo("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
        assertThat(CanonicalJson.digest(parse("{\"b\":1, \"a\":[true,null]}"))).isEqualTo(CanonicalJson.sha256Hex("{\"a\":[true,null],\"b\":1}"));
    }

    /**
     * Jackson 3's doubleValue() throws for a BigInteger or BigDecimal past the double range; the writers read
     * numbers through numberValue() so such a body is judged (JCS refuses it, the lenient form writes what the
     * program would), never a 500.
     */
    @Test
    void numbersPastTheDoubleRangeDoNotThrowFromJackson() {
        tools.jackson.databind.node.JsonNodeFactory f = tools.jackson.databind.node.JsonNodeFactory.instance;
        JsonNode bigInteger = f.numberNode(new java.math.BigInteger("1" + "0".repeat(400)));
        JsonNode bigDecimal = f.numberNode(new java.math.BigDecimal("1e400"));
        for (JsonNode huge : List.of(bigInteger, bigDecimal)) {
            org.junit.jupiter.api.Assertions.assertDoesNotThrow(() -> CanonicalJson.serialize(huge));
            org.assertj.core.api.Assertions.assertThatThrownBy(() -> Jcs.canonicalize(huge))
                .isInstanceOf(IllegalArgumentException.class);
        }
    }
}
