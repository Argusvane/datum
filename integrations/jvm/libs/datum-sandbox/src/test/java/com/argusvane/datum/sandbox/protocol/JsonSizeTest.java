package com.argusvane.datum.sandbox.protocol;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * The size a parsed tree is measured at against a cap: never more than the bytes of any UTF-8 JSON text
 * that reads as it, so a body the routes took under their byte cap is never refused again as a tree; exact for compact
 * ASCII text without escapes; and bounded work for a tree of any size, a cyclic one included.
 */
class JsonSizeTest {

    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

    private static final JsonMapper PLAIN = JsonMapper.builder().build();
    private static final JsonMapper DECIMALS = JsonMapper.builder().enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS).build();

    @ParameterizedTest
    @ValueSource(strings = {
        "{}", "[]", " { \"a\" : [ 1 , 2 ] } ", "\t[\n]\n", "1e5", "-1E+300", "1.0e-7", "[1e5,1e5,1e5,2e9]", "100.000", "-0", "-0.0",
        "0.000000000000000000000001", "123456789012345678901234567890", "-98765432109876543210.5e-3",
        "\"\\u00e9\\u0800\\ud83d\\ude00\"", "\"é漢😀\"", "{\"a\":1,\"a\":2}", "\"\\n\\t\\\"\\\\\\/\"", "\"\\ud800\"",
        "{\"k\\u00e9y\":[true,false,null]}", "[[[[[]]]]]", "[\"\",\"\",{}]"})
    void neverMoreThanTheBytesOfATextThatReadsAsIt(String text) throws Exception {
        long bytes = text.getBytes(StandardCharsets.UTF_8).length;
        for (JsonMapper mapper : new JsonMapper[] {PLAIN, DECIMALS}) {
            JsonNode tree = mapper.readTree(text);
            assertThat(JsonSize.atLeast(tree, Long.MAX_VALUE)).as(text).isLessThanOrEqualTo(bytes);
            assertThat(JsonSize.exceeds(tree, bytes)).as(text).isFalse();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"{}", "[1,22,-333]", "{\"a\":\"b\",\"c\":[true,false,null,{\"d\":9223372036854775807}]}", "\"plain\""})
    void exactForCompactAsciiText(String text) throws Exception {
        assertThat(JsonSize.atLeast(PLAIN.readTree(text), Long.MAX_VALUE)).isEqualTo(text.length());
        assertThat(JsonSize.exceeds(PLAIN.readTree(text), text.length() - 1)).isTrue();
    }

    @Test
    void aLargeIntegerCountsItsDigits() {
        BigInteger big = BigInteger.TEN.pow(5000);
        long measured = JsonSize.atLeast(NODES.numberNode(big), Long.MAX_VALUE);
        assertThat(measured).isBetween(4990L, 5001L);
        assertThat(JsonSize.atLeast(NODES.numberNode(big.negate()), Long.MAX_VALUE)).isEqualTo(measured + 1);
        assertThat(JsonSize.atLeast(NODES.numberNode(new BigDecimal(big, 4000)), Long.MAX_VALUE)).as("the unscaled digits").isEqualTo(measured);
    }

    @Test
    @Timeout(5)
    void stopsOnceTheCapIsPassedWhateverTheTreeHolds() {
        ObjectNode cyclic = NODES.objectNode();
        cyclic.set("self", cyclic);
        assertThat(JsonSize.exceeds(cyclic, 1 << 20)).isTrue();

        ArrayNode wide = NODES.arrayNode();
        wide.add(wide);
        wide.add(wide);
        assertThat(JsonSize.exceeds(wide, 1 << 20)).isTrue();

        String huge = "x".repeat(50_000_000);
        long started = System.nanoTime();
        assertThat(JsonSize.atLeast(NODES.stringNode(huge), 1024)).isGreaterThan(1024);
        assertThat(System.nanoTime() - started).as("a string past the budget is not walked").isLessThan(1_000_000_000L);
    }
}
