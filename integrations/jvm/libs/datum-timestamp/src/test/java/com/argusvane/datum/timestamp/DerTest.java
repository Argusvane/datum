package com.argusvane.datum.timestamp;

import static com.argusvane.datum.timestamp.Fixtures.hex;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The DER the timestamp server writes and reads, and the reader's bounds and words. */
class DerTest {

    @Test
    void writesTheKnownEncodings() {
        assertThat(hex(Der.integer(0))).isEqualTo("020100");
        assertThat(hex(Der.integer(127))).isEqualTo("02017f");
        assertThat(hex(Der.integer(128))).isEqualTo("02020080");
        assertThat(hex(Der.integer(256))).isEqualTo("02020100");
        assertThat(hex(Der.unsigned(new byte[] {0, 0, (byte) 0xff, (byte) 0xff, (byte) 0xff, (byte) 0xff}))).isEqualTo("020500ffffffff");
        assertThat(hex(Der.bool(true))).isEqualTo("0101ff");
        assertThat(hex(Der.nul())).isEqualTo("0500");
        assertThat(hex(Der.oid("1.2.840.113549"))).isEqualTo("06062a864886f70d");
        assertThat(hex(Der.oid("2.16.840.1.101.3.4.2.1"))).isEqualTo("0609608648016503040201");
        // Bit 25 (systemFailure): four bytes, six unused bits.
        assertThat(hex(NamedBits.of(25))).isEqualTo("03050600000040");
        assertThat(hex(NamedBits.of(0))).isEqualTo("03020780");
        long seconds = Fixtures.OCT_5.getEpochSecond();
        assertThat(hex(Der.generalizedTime(seconds, null))).isEqualTo("180f32303236313030353132303030315a");
        assertThat(new String(Arrays.copyOfRange(Der.generalizedTime(seconds, 250), 2, Der.generalizedTime(seconds, 250).length), StandardCharsets.US_ASCII))
            .isEqualTo("20261005120001.25Z");
        // Long lengths.
        assertThat(hex(Arrays.copyOf(Der.octetString(Fixtures.repeat('a', 200)), 3))).isEqualTo("0481c8");
        assertThat(hex(Arrays.copyOf(Der.octetString(Fixtures.repeat('a', 400)), 4))).isEqualTo("04820190");
        // SET OF is sorted; an implicit tag keeps the constructed bit.
        assertThat(hex(Der.setOf(Der.integer(2), Der.integer(1)))).isEqualTo(hex(Der.tlv(Der.SET, Der.concat(Der.integer(1), Der.integer(2)))));
        assertThat(hex(Arrays.copyOf(Der.implicit(0, Der.setOf(Der.integer(5))), 4))).isEqualTo("a0030201");
        assertThat(hex(Der.implicit(0, Der.integer(5)))).isEqualTo("800105");
    }

    @Test
    void readsObjectIdentifiersOfAnySizeBothWays() {
        for (String oid : List.of("1.2.840.113549.1.9.16.1.4", TimestampAuthority.DEFAULT_POLICY, "2.999.3", "0.39",
            "1.3.6.1.4.1.99999.18446744073709551616")) {
            byte[] encoded = Der.oid(oid);
            assertThat(Der.readOid(encoded, Der.readAll(encoded))).isEqualTo(oid);
        }
        for (String bad : List.of("1.40", "3.1", "1", "1.2.03", "1..2", "")) {
            assertThat(Der.validOid(bad)).as(bad).isFalse();
        }
        // What the reader would refuse is not written either.
        assertThat(Der.validOid("2.25." + "9".repeat(43))).as("An arc over 140 bits.").isFalse();
        assertThat(Der.validOid("1.2" + ".123456789".repeat(20))).as("Over 64 bytes encoded.").isFalse();
    }

    @Test
    void refusesLongObjectIdentifiersAtOnceBeforeAnyArithmetic() {
        // One arc of 16 KB took an unbounded reader minutes.
        byte[] arc = Der.concat(new byte[] {(byte) 0x81}, Fixtures.repeat(0xff, 16 * 1024 - 2), new byte[] {0x7f});
        byte[] longArc = Der.tlv(Der.OID, Der.concat(new byte[] {0x2a}, arc));
        byte[] manyArcs = Der.tlv(Der.OID, Der.concat(new byte[] {0x2a}, Fixtures.repeat(0x01, 100)));
        byte[] twentyOne = Der.tlv(Der.OID, Der.concat(new byte[] {0x2a}, Fixtures.repeat(0x81, 20), new byte[] {0x01}));
        long started = System.nanoTime();
        Map<String, byte[]> cases = new LinkedHashMap<>();
        cases.put("one long arc", longArc);
        cases.put("many arcs", manyArcs);
        cases.put("a 21-byte arc", twentyOne);
        cases.forEach((name, der) -> assertThatThrownBy(() -> Der.readOid(der, Der.readAll(der))).as(name)
            .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("longer than"));
        // The largest arc read: 20 bytes.
        byte[] twenty = Der.tlv(Der.OID, Der.concat(new byte[] {0x2a}, Fixtures.repeat(0x81, 19), new byte[] {0x01}));
        assertThat(Der.readOid(twenty, Der.readAll(twenty))).startsWith("1.2.");

        // In a request: refused as badDataFormat, whether the hash algorithm or the policy carries it.
        byte[] imprint = Der.sequence(Der.sequence(longArc, Der.nul()), Der.octetString(Fixtures.repeat(1, 32)));
        byte[] good = Der.sequence(Der.sequence(Der.oid("2.16.840.1.101.3.4.2.1"), Der.nul()), Der.octetString(Fixtures.repeat(1, 32)));
        for (byte[] query : List.of(Der.sequence(Der.integer(1), imprint), Der.sequence(Der.integer(1), good, longArc))) {
            assertThat(query.length).isGreaterThan(16 * 1024);
            assertThatThrownBy(() -> TimestampQuery.parse(query))
                .isInstanceOfSatisfying(TimestampRefusedException.class, e -> {
                    assertThat(e.failInfo()).isEqualTo(TimestampRefusal.FAIL_BAD_DATA_FORMAT);
                    assertThat(e.getMessage()).contains("longer than 64 bytes");
                });
        }
        assertThat((System.nanoTime() - started) / 1e9).as("Refused in well under a second.").isLessThan(0.5);
    }

    @Test
    void theReaderRefusesWhatIsNotDer() {
        List<byte[]> bad = List.of(new byte[0], Fixtures.unhex("30"), Fixtures.unhex("30050201"), Fixtures.unhex("3081050201010201"),
            Fixtures.unhex("1f0100"), Fixtures.unhex("300000"));
        for (byte[] der : bad) {
            assertThatThrownBy(() -> Der.readAll(der)).as(hex(der)).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    void theReaderWordsEachRefusalAsTheWireHasIt() {
        assertThatThrownBy(() -> Der.readAll(new byte[0])).hasMessage("DER: truncated.");
        assertThatThrownBy(() -> Der.readAll(Fixtures.unhex("1f0100"))).hasMessage("DER: multi-byte tags are not read.");
        assertThatThrownBy(() -> Der.readAll(Fixtures.unhex("3080"))).hasMessage("DER: bad length.");
        assertThatThrownBy(() -> Der.readAll(Fixtures.unhex("3081050201010201"))).hasMessage("DER: a length not in its shortest form.");
        assertThatThrownBy(() -> Der.readAll(Fixtures.unhex("30050201"))).hasMessage("DER: an element runs past its parent.");
        assertThatThrownBy(() -> Der.readAll(Fixtures.unhex("300000"))).hasMessage("DER: bytes after the element.");
        byte[] notShortest = Fixtures.unhex("06032a8001");
        assertThatThrownBy(() -> Der.readOid(notShortest, Der.readAll(notShortest))).hasMessage("DER: an object identifier arc not in its shortest form.");
    }
}
