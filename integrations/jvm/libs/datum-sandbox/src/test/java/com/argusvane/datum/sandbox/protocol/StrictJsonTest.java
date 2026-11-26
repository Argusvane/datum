package com.argusvane.datum.sandbox.protocol;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/** Strict reading and plain writing of a run's JSON. A key with NUL in it, and the empty key, are read. */
class StrictJsonTest {

    @ParameterizedTest
    @ValueSource(strings = {"\"\\ud800\"", "\"\\udc00x\"", "{\"\\ud800\":1}", "\ufeff{}", "", " ", "{} x", "{}{}", "[1,]", "01", "NaN", "{'a':1}", "/*c*/{}"})
    void notStrictJson(String text) {
        assertThatThrownBy(() -> StrictJson.decode(text)).isInstanceOf(StrictJson.NotJsonException.class);
    }

    @ParameterizedTest
    @ValueSource(strings = {"1", "-0", "\t{}\n", "\"\\ud83d\\ude00\"", "{\"a\":1,\"a\":2}", "\"\\u0000\"", "1.0e5", "{\"x\\u0000\":1}", "{\"\":1}",
        "{\"\\u0000x\":1}", "{\"\\u0000\":1}", "[{\"a\":{\"\\u0000b\":1}}]"})
    void whatIsRead(String text) throws Exception {
        assertThat(StrictJson.decode(text)).isNotNull();
        assertThat(StrictJson.decode("{\"a\":1,\"a\":2}").get("a").intValue()).as("last wins").isEqualTo(2);
    }

    @Test
    void depthIs512() throws Exception {
        assertThat(StrictJson.decode("[".repeat(511) + "]".repeat(511))).isNotNull();
        assertThatThrownBy(() -> StrictJson.decode("[".repeat(512) + "]".repeat(512))).isInstanceOf(StrictJson.NotJsonException.class);
    }

    @Test
    void malformedUtf8IsNotJson() {
        assertThatThrownBy(() -> StrictJson.decode(new byte[] {'"', (byte) 0xff, '"'})).isInstanceOf(StrictJson.NotJsonException.class);
        assertThatThrownBy(() -> StrictJson.decode(new byte[] {'"', (byte) 0xED, (byte) 0xA0, (byte) 0x80, '"'}))
            .as("a surrogate encoded as UTF-8 (CESU)").isInstanceOf(StrictJson.NotJsonException.class);
    }

    @Test
    void longStringsAreRead() throws Exception {
        String big = "\"" + "a".repeat(25_000_000) + "\"";
        assertThat(StrictJson.decode(big.getBytes(StandardCharsets.UTF_8)).stringValue()).hasSize(25_000_000);
    }

    @Test
    void writingRefusesWhatJsonCannotCarry() {
        ObjectNode nan = JsonNodeFactory.instance.objectNode();
        nan.put("x", Double.NaN);
        assertThatThrownBy(() -> StrictJson.encode(nan)).isInstanceOf(IllegalArgumentException.class).hasMessageContaining("NaN");
        ObjectNode inf = JsonNodeFactory.instance.objectNode();
        inf.set("deep", JsonNodeFactory.instance.arrayNode().add(Float.NEGATIVE_INFINITY));
        assertThatThrownBy(() -> StrictJson.encode(inf)).isInstanceOf(IllegalArgumentException.class);
        ObjectNode lone = JsonNodeFactory.instance.objectNode();
        lone.put("x", "a\ud800");
        assertThatThrownBy(() -> StrictJson.encode(lone)).isInstanceOf(IllegalArgumentException.class);
        ObjectNode key = JsonNodeFactory.instance.objectNode();
        key.put("\udc00", 1);
        assertThatThrownBy(() -> StrictJson.encode(key)).isInstanceOf(IllegalArgumentException.class);
    }

    /** Slashes and non-ASCII are written as they are. */
    @Test
    void writingKeepsSlashesAndUnicode() {
        ObjectNode node = JsonNodeFactory.instance.objectNode();
        node.put("p", "a/b \u00e9 \ud83d\ude00");
        node.put("n", 1.5);
        assertThat(StrictJson.encode(node)).isEqualTo("{\"p\":\"a/b \u00e9 \ud83d\ude00\",\"n\":1.5}");
    }
}
