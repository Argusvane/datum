package com.argusvane.datum.web.json;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argusvane.datum.core.RequestTooLargeException;
import com.argusvane.datum.web.error.BadRequestException;
import com.argusvane.datum.web.error.UnsupportedMediaTypeException;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

class JsonBodiesTest {

    private final DatumJsonMapper json = DatumJsonMapper.create(1024);

    @Test
    void onlyJsonContentTypesPass() {
        JsonBodies.requireJson("application/json");
        JsonBodies.requireJson("application/json; charset=UTF-8");
        JsonBodies.requireJson("application/problem+json");
        for (String bad : new String[] {null, "", "text/plain", "application/x-www-form-urlencoded", "application/json; charset=iso-8859-1",
            "application/jsonx", "multipart/form-data; boundary=x"}) {
            assertThatThrownBy(() -> JsonBodies.requireJson(bad)).as(String.valueOf(bad)).isInstanceOf(UnsupportedMediaTypeException.class);
        }
    }

    @Test
    void theCapIsCountedOnTheRawStream() {
        byte[] ok = new byte[100];
        assertThat(JsonBodies.read(new ByteArrayInputStream(ok), -1, 100)).hasSize(100);
        assertThatThrownBy(() -> JsonBodies.read(new ByteArrayInputStream(new byte[101]), -1, 100))
            .isInstanceOfSatisfying(RequestTooLargeException.class, e -> {
                assertThat(e.limit()).isEqualTo(100);
                assertThat(e.code()).isEqualTo("bad_document");
            });
    }

    @Test
    void aDeclaredLengthOverTheCapRefusesBeforeReading() {
        InputStream neverRead = new InputStream() {
            @Override
            public int read() {
                throw new AssertionError("the stream must not be read");
            }
        };
        assertThatThrownBy(() -> JsonBodies.read(neverRead, 5000, 100)).isInstanceOf(RequestTooLargeException.class);
    }

    @Test
    void parsingRefusesWhatIsNotOneJsonValue() {
        JsonNode node = JsonBodies.parse(json, "{\"a\":[1,2]}".getBytes(StandardCharsets.UTF_8));
        assertThat(node.get("a")).hasSize(2);
        assertBad("");
        assertBad("   ");
        assertBad("{\"a\":1} trailing");
        assertBad("{\"a\":1}{\"b\":2}");
        assertBad("{not json");
        // A repeated key, at any depth and however it is spelled, is malformed JSON like the rest: the same 400.
        assertBad("{\"a\":1,\"a\":2}");
        assertBad("{\"a\":{\"b\":[{\"c\":1,\"c\":1}]}}");
        assertBad("{\"a\":1,\"\\u0061\":2}");
        assertThat(JsonBodies.parse(json, "{\"a\":{\"a\":1},\"b\":[{\"a\":2},{\"a\":3}]}".getBytes(StandardCharsets.UTF_8)).get("b"))
            .as("the same key in different objects is no repeat").hasSize(2);
        assertThatThrownBy(() -> JsonBodies.parse(json, new byte[] {'{', '"', (byte) 0xC3, (byte) 0x28, '"', ':', '1', '}'}))
            .isInstanceOf(BadRequestException.class);
    }

    @Test
    void nestingNumbersAndStringsAreLimited() {
        assertBad("[".repeat(300) + "]".repeat(300));
        assertBad("{\"n\":" + "9".repeat(1001) + "}");
        // A string cannot be longer than the body cap the mapper was built for (1024).
        assertBad("{\"s\":\"" + "x".repeat(2000) + "\"}");
        JsonBodies.parse(json, ("[".repeat(256) + "]".repeat(256)).getBytes(StandardCharsets.UTF_8));
    }

    private void assertBad(String text) {
        assertThatThrownBy(() -> JsonBodies.parse(json, text.getBytes(StandardCharsets.UTF_8)))
            .as(text.length() > 40 ? text.substring(0, 40) : text)
            .isInstanceOfSatisfying(BadRequestException.class, e -> assertThat(e.code()).isEqualTo("bad_document"));
    }
}
