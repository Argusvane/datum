package com.argusvane.datum.webauthn;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The CBOR pre-gate: every refusal of the hand reader it replaced (the old {@code Cbor} class, kept as its
 * cases here), and the repeated map key it now refuses too, under the name the library reads a key by.
 */
class CborGateTest {

    private static byte[] hex(String text) {
        return HexFormat.of().parseHex(text);
    }

    private static String hexOf(String text) {
        return HexFormat.of().formatHex(text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    /** What an authenticator writes passes: maps keyed by integers and text, byte and text strings, lists, tags. */
    @Test
    void theCborAWebAuthnAuthenticatorWritesPasses() {
        Map<Object, Object> value = new LinkedHashMap<>();
        value.put("fmt", "none");
        value.put("attStmt", new LinkedHashMap<>());
        value.put(1L, -7L);
        value.put(-2L, new TestCbor.Bytes(new byte[] {1, 2}));
        value.put("list", Arrays.asList(1L, "two", true, null));
        value.put("big", 70000L);
        assertThatCode(() -> CborGate.whole(TestCbor.encode(value))).doesNotThrowAnyException();
        // Undefined, a tag read through, the largest signed 64-bit integer.
        assertThatCode(() -> CborGate.whole(hex("f7"))).doesNotThrowAnyException();
        assertThatCode(() -> CborGate.whole(hex("c11a514b67b0"))).doesNotThrowAnyException();
        assertThatCode(() -> CborGate.whole(hex("1b7fffffffffffffff"))).doesNotThrowAnyException();
        assertThatCode(() -> CborGate.whole(hex("3b7fffffffffffffff"))).doesNotThrowAnyException();
        // Text keys that are not an integer's spelling as the library reads one: a leading zero, a plus, "-0", digits
        // past a 64-bit integer.
        for (String text : List.of("01", "+1", "-0", "1x", "99999999999999999999")) {
            String key = HexFormat.of().formatHex(TestCbor.encode(text));
            assertThatCode(() -> CborGate.whole(hex("a2" + "01" + "00" + key + "00"))).as(text).doesNotThrowAnyException();
        }
    }

    /** The old reader's refusals, byte for byte. */
    @Test
    void theOldRefusalsStand() {
        for (String bad : List.of(
            "f90000",          // a half float
            "fa00000000",      // a single float
            "fb0000000000000000", // a double
            "e0",              // a simple value
            "f800",            // a simple value in the next byte
            "5f",              // an indefinite byte string
            "9f",              // an indefinite array
            "bf",              // an indefinite map
            "ff",              // the break byte alone
            "1c",              // a reserved argument
            "8201",            // an array that ends early
            "a101",            // a map that ends early
            "1b8000000000000000", // past a signed 64-bit integer
            "3b8000000000000000", // past the negative end too
            "61ff",            // a text string that is not UTF-8
            "62c3",            // a text string that runs past the end
            "4501",            // a byte string that runs past the end
            "19ff",            // an argument that ends early
            "a14100",          // a byte-string key
            "a1f500",          // a boolean key
            "a1810000",        // an array key
            "a1a00000",        // a map key
            "0102"             // bytes after the item
        )) {
            assertThatThrownBy(() -> CborGate.whole(hex(bad))).as(bad).isInstanceOf(IllegalArgumentException.class);
        }
        // Nesting past 16.
        assertThatCode(() -> CborGate.whole(hex("81".repeat(16) + "01"))).doesNotThrowAnyException();
        assertThatThrownBy(() -> CborGate.whole(hex("81".repeat(17) + "01"))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> CborGate.whole(hex("c1".repeat(17) + "01"))).as("tags nest too").isInstanceOf(IllegalArgumentException.class);
        // A count past what is left refuses at once, whatever the count.
        assertThatThrownBy(() -> CborGate.whole(hex("9b7fffffffffffffff"))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> CborGate.whole(hex("bb7fffffffffffffff"))).isInstanceOf(IllegalArgumentException.class);
    }

    /** A map that names one key twice (RFC 8949 5.6), in every spelling of the key. */
    @Test
    void aRepeatedKeyIsRefused() {
        for (String bad : List.of(
            "a2" + "01" + "00" + "01" + "00",       // an integer key twice
            "a2" + "01" + "00" + "1801" + "00",     // the same integer in a longer argument
            "a2" + "20" + "00" + "3800" + "00",     // a negative key twice
            "a2" + "6166" + "00" + "6166" + "00",   // a text key twice
            "a2" + "01" + "00" + "c101" + "00",     // a tagged key is its content
            // The library (Jackson) names an integer key by its decimal text, so an integer key and the text of its
            // digits are one key to it: refused, in either order and for a negative key too.
            "a2" + "01" + "00" + "6131" + "00",
            "a2" + "6131" + "00" + "01" + "00",
            "a2" + "21" + "00" + "622d32" + "00",
            "a2" + "1b7fffffffffffffff" + "00" + "73" + hexOf("9223372036854775807") + "00"
        )) {
            assertThatThrownBy(() -> CborGate.whole(hex(bad))).as(bad).isInstanceOf(IllegalArgumentException.class);
        }
        // A text key spelling an integer is refused alone too: the library would read it as that integer label (a COSE
        // key written with text labels), which no authenticator writes.
        for (String bad : List.of("a1" + "6131" + "02", "a1" + "622d32" + "00", "a1" + "6130" + "00")) {
            assertThatThrownBy(() -> CborGate.whole(hex(bad))).as(bad).isInstanceOf(IllegalArgumentException.class);
        }
        // Nested maps keep their own keys.
        assertThatCode(() -> CborGate.whole(hex("a2" + "01" + "a1" + "01" + "00" + "02" + "a1" + "01" + "00"))).doesNotThrowAnyException();
    }

    /** {@link CborGate#map} reads one map at an offset and says where it ends; anything else there is refused. */
    @Test
    void oneMapAtAnOffset() {
        byte[] bytes = hex("00" + "a10102" + "ff");
        assertThat(CborGate.map(bytes, 1)).isEqualTo(4);
        assertThatThrownBy(() -> CborGate.map(hex("8101"), 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> CborGate.map(hex("01"), 1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> CborGate.map(hex("bf0102ff"), 0)).isInstanceOf(IllegalArgumentException.class);
    }
}
