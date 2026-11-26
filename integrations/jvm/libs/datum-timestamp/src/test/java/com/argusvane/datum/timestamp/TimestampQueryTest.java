package com.argusvane.datum.timestamp;

import static com.argusvane.datum.timestamp.Fixtures.hex;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/** Requests: what is kept from them, and what is refused, word for word (the statusString is on the wire). */
class TimestampQueryTest {

    private static final String SHA256 = "2.16.840.1.101.3.4.2.1";

    private static byte[] imprint(String oid, byte[] hash, boolean nul) {
        byte[] algorithm = nul ? Der.sequence(Der.oid(oid), Der.nul()) : Der.sequence(Der.oid(oid));
        return Der.sequence(algorithm, Der.octetString(hash));
    }

    private static final byte[] GOOD = imprint(SHA256, Fixtures.repeat(1, 32), true);

    @Test
    void keepsWhatTheRequestSays() throws Exception {
        byte[] digest = java.security.MessageDigest.getInstance("SHA-384").digest("data".getBytes(StandardCharsets.US_ASCII));
        TimestampQuery query = TimestampQuery.parse(TimestampQuery.forDigest("sha384", digest, true, new byte[] {1, 2, 3}, "1.2.3.4"));
        assertThat(query.algorithm()).isEqualTo("sha384");
        assertThat(query.algorithmOid()).isEqualTo("2.16.840.1.101.3.4.2.2");
        assertThat(query.hash()).isEqualTo(digest);
        assertThat(query.policy()).isEqualTo("1.2.3.4");
        assertThat(hex(query.nonce())).isEqualTo("0203010203");
        assertThat(query.certReq()).isTrue();

        TimestampQuery plain = TimestampQuery.parse(TimestampQuery.forData("data".getBytes(StandardCharsets.US_ASCII), "sha256", false, null, null));
        assertThat(plain.policy()).isNull();
        assertThat(plain.nonce()).isNull();
        assertThat(plain.certReq()).isFalse();
        assertThat(plain.hash()).isEqualTo(java.security.MessageDigest.getInstance("SHA-256").digest("data".getBytes(StandardCharsets.US_ASCII)));
    }

    @Test
    void writesTheRequestThePdfKernelAndOpensslWrite() throws Exception {
        // The kernel's timestampRequest(): SEQ{INTEGER 1, SEQ{SEQ{sha256, NULL}, OCTET digest}, BOOLEAN TRUE}; openssl ts
        // -query -sha256 -cert -no_nonce writes the same bytes.
        byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(new byte[] {1, 2, 3});
        byte[] expected = Der.sequence(Der.integer(1), Der.sequence(Der.sequence(Der.oid(SHA256), Der.nul()), Der.octetString(digest)), Der.bool(true));
        assertThat(hex(TimestampQuery.forData(new byte[] {1, 2, 3}))).isEqualTo(hex(expected));
        assertThat(hex(TimestampQuery.forDigest("sha256", digest))).isEqualTo(hex(expected));
        // A nonce is written as an unsigned INTEGER: leading zeros dropped, a zero put before a high bit.
        byte[] withNonce = TimestampQuery.forDigest("sha256", digest, false, new byte[] {0, 0, (byte) 0x80}, null);
        assertThat(hex(TimestampQuery.parse(withNonce).nonce())).isEqualTo("02020080");
    }

    @Test
    void refusesToWriteWhatItCannot() {
        assertThatThrownBy(() -> TimestampQuery.forDigest("sha1", new byte[20])).isInstanceOf(IllegalArgumentException.class)
            .hasMessage("No timestamp imprint over sha1.");
        assertThatThrownBy(() -> TimestampQuery.forDigest("sha256", new byte[32], true, null, "1.40"))
            .isInstanceOf(IllegalArgumentException.class).hasMessage("DER: 1.40 is not an object identifier.");
    }

    @Test
    void keepsTheNonceAsItCameEvenWhenNotInItsShortestForm() {
        // The reader takes a positive nonce of up to 64 bytes in whatever INTEGER form it came (the token echoes its
        // value, TimestampAuthority); it does not ask for the shortest form.
        byte[] nonce = Fixtures.unhex("02020005");
        TimestampQuery query = TimestampQuery.parse(Der.sequence(Der.integer(1), GOOD, nonce));
        assertThat(query.nonce()).isEqualTo(nonce);
        byte[] longest = Der.tlv(Der.INTEGER, Fixtures.repeat(0x7f, 64));
        assertThat(TimestampQuery.parse(Der.sequence(Der.integer(1), GOOD, longest)).nonce()).isEqualTo(longest);
        assertThatThrownBy(() -> TimestampQuery.parse(Der.sequence(Der.integer(1), GOOD, Der.tlv(Der.INTEGER, Fixtures.repeat(0x7f, 65)))))
            .hasMessage("The request is not a TimeStampReq: a nonce that is not a positive integer of at most 64 bytes.");
    }

    @Test
    void keepsTheImprintAsSentWithOrWithoutNullParameters() {
        byte[] bare = imprint(SHA256, Fixtures.repeat(2, 32), false);
        assertThat(TimestampQuery.parse(Der.sequence(Der.integer(1), bare)).messageImprint()).isEqualTo(bare);
        assertThat(TimestampQuery.parse(Der.sequence(Der.integer(1), GOOD)).messageImprint()).isEqualTo(GOOD);
    }

    static Stream<Arguments> refusals() {
        int bad = TimestampRefusal.FAIL_BAD_DATA_FORMAT;
        return Stream.of(
            Arguments.of("sha1", Der.sequence(Der.integer(1), imprint("1.3.14.3.2.26", Fixtures.repeat(1, 20), true)),
                TimestampRefusal.FAIL_BAD_ALG, "SHA-1 imprints are refused: use SHA-256, SHA-384 or SHA-512."),
            Arguments.of("md5", Der.sequence(Der.integer(1), imprint("1.2.840.113549.2.5", Fixtures.repeat(1, 16), true)),
                TimestampRefusal.FAIL_BAD_ALG, "The imprint algorithm 1.2.840.113549.2.5 is not taken: use SHA-256, SHA-384 or SHA-512."),
            Arguments.of("version 2", Der.sequence(Der.integer(2), GOOD), bad, "Only version 1 timestamp requests are read."),
            Arguments.of("no imprint", Der.sequence(Der.integer(1)), bad, "Only version 1 timestamp requests are read."),
            Arguments.of("short digest", Der.sequence(Der.integer(1), imprint(SHA256, "short".getBytes(StandardCharsets.US_ASCII), false)), bad,
                "A SHA256 imprint is 32 bytes; this one is 5."),
            Arguments.of("fields out of order", Der.sequence(Der.integer(1), GOOD, Der.bool(true), Der.integer(5)), bad,
                "The request is not a TimeStampReq: fields out of order."),
            Arguments.of("a field twice", Der.sequence(Der.integer(1), GOOD, Der.integer(5), Der.integer(6)), bad,
                "The request is not a TimeStampReq: fields out of order."),
            Arguments.of("an unknown field", Der.sequence(Der.integer(1), GOOD, Der.utf8("x")), bad,
                "The request is not a TimeStampReq: an unknown field."),
            Arguments.of("negative nonce", Der.sequence(Der.integer(1), GOOD, Der.tlv(Der.INTEGER, new byte[] {(byte) 0xff})), bad,
                "The request is not a TimeStampReq: a nonce that is not a positive integer of at most 64 bytes."),
            Arguments.of("empty nonce", Der.sequence(Der.integer(1), GOOD, Der.tlv(Der.INTEGER, new byte[0])), bad,
                "The request is not a TimeStampReq: a nonce that is not a positive integer of at most 64 bytes."),
            Arguments.of("extension", Der.sequence(Der.integer(1), GOOD, Der.tlv(0xa0, new byte[0])),
                TimestampRefusal.FAIL_UNACCEPTED_EXTENSION, "This timestamp server accepts no request extensions."),
            Arguments.of("an extension before the algorithm is judged",
                Der.sequence(Der.integer(1), imprint("1.3.14.3.2.26", Fixtures.repeat(1, 20), true),
                    Der.tlv(0xa0, Der.sequence(Der.oid("1.2.3.4"), Der.octetString(new byte[0])))),
                TimestampRefusal.FAIL_UNACCEPTED_EXTENSION, "This timestamp server accepts no request extensions."),
            Arguments.of("trailing bytes", Der.concat(Der.sequence(Der.integer(1), GOOD), new byte[] {0}), bad,
                "The request is not a TimeStampReq: DER: bytes after the element.."),
            Arguments.of("not DER", "hello".getBytes(StandardCharsets.US_ASCII), bad,
                "The request is not a TimeStampReq: DER: an element runs past its parent.."),
            Arguments.of("not a TimeStampReq", "not a TimeStampReq".getBytes(StandardCharsets.US_ASCII), bad,
                "The request is not a TimeStampReq: DER: an element runs past its parent.."),
            Arguments.of("empty", new byte[0], bad, "The request is not a TimeStampReq: DER: truncated.."),
            Arguments.of("not a SEQUENCE", Der.integer(1), bad, "The request is not a TimeStampReq: not a SEQUENCE."),
            Arguments.of("a version that is no integer", Der.sequence(Der.bool(true), GOOD), bad,
                "The request is not a TimeStampReq: DER: not an integer.."),
            Arguments.of("no MessageImprint", Der.sequence(Der.integer(1), Der.integer(1)), bad,
                "The request is not a TimeStampReq: no MessageImprint."),
            Arguments.of("a malformed MessageImprint", Der.sequence(Der.integer(1), Der.sequence(Der.sequence(Der.oid(SHA256)))), bad,
                "The request is not a TimeStampReq: a malformed MessageImprint."),
            Arguments.of("parameters other than NULL",
                Der.sequence(Der.integer(1), Der.sequence(Der.sequence(Der.oid(SHA256), Der.integer(0)), Der.octetString(Fixtures.repeat(1, 32)))), bad,
                "The request is not a TimeStampReq: a malformed hash AlgorithmIdentifier."),
            Arguments.of("a BOOLEAN of two bytes", Der.sequence(Der.integer(1), GOOD, Der.tlv(Der.BOOLEAN, new byte[] {1, 1})), bad,
                "The request is not a TimeStampReq: DER: not a boolean.."));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("refusals")
    void refusesWithTheWiresWords(String name, byte[] der, int failInfo, String message) {
        assertThatThrownBy(() -> TimestampQuery.parse(der)).isInstanceOfSatisfying(TimestampRefusedException.class, e -> {
            assertThat(e.failInfo()).as(name).isEqualTo(failInfo);
            assertThat(e.getMessage()).isEqualTo(message);
            assertThat(e.httpStatus()).isEqualTo(400);
            assertThat(e.refusal().httpStatus()).isEqualTo(400);
            // The rejection bytes the client reads (RFC 3161 2.4.2: status rejection, the text, the failure bit).
            assertThat(hex(e.refusal().toResponse())).isEqualTo(hex(
                Der.sequence(Der.sequence(Der.integer(2), Der.sequence(Der.utf8(message)), NamedBits.of(failInfo)))));
        });
    }

    @Test
    void readsAnyNonZeroBooleanOctetAsTrue() {
        // Any non-zero octet is TRUE (BER); FALSE written out is read as FALSE.
        assertThat(TimestampQuery.parse(Der.sequence(Der.integer(1), GOOD, Der.tlv(Der.BOOLEAN, new byte[] {1}))).certReq()).isTrue();
        assertThat(TimestampQuery.parse(Der.sequence(Der.integer(1), GOOD, Der.bool(false))).certReq()).isFalse();
    }
}
