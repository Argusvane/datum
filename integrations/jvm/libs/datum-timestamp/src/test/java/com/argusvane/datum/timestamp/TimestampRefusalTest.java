package com.argusvane.datum.timestamp;

import static com.argusvane.datum.timestamp.Fixtures.hex;
import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.bouncycastle.tsp.TimeStampResponse;
import org.junit.jupiter.api.Test;

/** A refusal as a TimeStampResp: status rejection, text, failure bit (RFC 3161 section 2.4.2). */
class TimestampRefusalTest {

    @Test
    void writesTheRejectionByteForByte() {
        byte[] der = new TimestampRefusal(TimestampRefusal.FAIL_BAD_ALG, "No SHA-1.").toResponse();
        assertThat(hex(der)).isEqualTo(hex(Der.sequence(Der.sequence(Der.integer(2), Der.sequence(Der.utf8("No SHA-1.")),
            Fixtures.unhex("03020780")))));
        // badAlg is exactly 03 02 07 80; systemFailure (bit 25) four bytes and six unused bits.
        assertThat(hex(der)).endsWith("03020780");
        assertThat(hex(new TimestampRefusal(TimestampRefusal.FAIL_SYSTEM_FAILURE, "x").toResponse())).endsWith("03050600000040");
    }

    @Test
    void everyFailureBitAsDerNamesItAndOpensslReadsIt() throws Exception {
        Map<Integer, String> names = Map.of(
            TimestampRefusal.FAIL_BAD_ALG, "badAlg",
            TimestampRefusal.FAIL_BAD_REQUEST, "badRequest",
            TimestampRefusal.FAIL_BAD_DATA_FORMAT, "badDataFormat",
            TimestampRefusal.FAIL_TIME_NOT_AVAILABLE, "timeNotAvailable",
            TimestampRefusal.FAIL_UNACCEPTED_POLICY, "unacceptedPolicy",
            TimestampRefusal.FAIL_UNACCEPTED_EXTENSION, "unacceptedExtension",
            TimestampRefusal.FAIL_SYSTEM_FAILURE, "systemFailure");
        for (Map.Entry<Integer, String> entry : names.entrySet()) {
            TimestampRefusal refusal = new TimestampRefusal(entry.getKey(), "Refused: " + entry.getValue() + ".");
            assertThat(refusal.failName()).isEqualTo(entry.getValue());
            assertThat(hex(refusal.toResponse())).isEqualTo(hex(Der.sequence(Der.sequence(Der.integer(2),
                Der.sequence(Der.utf8(refusal.message())), NamedBits.of(entry.getKey())))));
            // Bouncy Castle reads the same bit back (its PKIFailureInfo constants are bit masks).
            TimeStampResponse read = new TimeStampResponse(refusal.toResponse());
            assertThat(read.getStatus()).isEqualTo(2);
            assertThat(read.getStatusString()).isEqualTo(refusal.message());
            assertThat(read.getFailInfo().intValue()).isEqualTo(bcMask(entry.getKey()));
            assertThat(read.getTimeStampToken()).isNull();
        }
    }

    @Test
    void anyBitTheRecordAcceptsIsWrittenAsItself() {
        for (int bit = 0; bit < 32; bit++) {
            TimestampRefusal refusal = new TimestampRefusal(bit, "x");
            assertThat(hex(refusal.toResponse())).as("bit " + bit).isEqualTo(hex(Der.sequence(Der.sequence(Der.integer(2),
                Der.sequence(Der.utf8("x")), NamedBits.of(bit)))));
        }
    }

    @Test
    void theServiceFailuresAre503AndTheRest400() {
        assertThat(new TimestampRefusal(TimestampRefusal.FAIL_SYSTEM_FAILURE, "x").httpStatus()).isEqualTo(503);
        assertThat(new TimestampRefusal(TimestampRefusal.FAIL_TIME_NOT_AVAILABLE, "x").httpStatus()).isEqualTo(503);
        for (int bit : new int[] {TimestampRefusal.FAIL_BAD_ALG, TimestampRefusal.FAIL_BAD_REQUEST, TimestampRefusal.FAIL_BAD_DATA_FORMAT,
            TimestampRefusal.FAIL_UNACCEPTED_POLICY, TimestampRefusal.FAIL_UNACCEPTED_EXTENSION}) {
            assertThat(new TimestampRefusal(bit, "x").httpStatus()).isEqualTo(400);
        }
        assertThat(new TimestampRefusal(TimestampRefusal.FAIL_SYSTEM_FAILURE, "x").failName()).isEqualTo("systemFailure");
        TimestampRefusedException exception = new TimestampRefusedException(TimestampRefusal.FAIL_SYSTEM_FAILURE, "Down.");
        assertThat(exception.httpStatus()).isEqualTo(503);
        assertThat(exception.code()).isEqualTo("timestamp.refused");
        assertThat(exception.failInfo()).isEqualTo(25);
    }

    /** Bouncy Castle's PKIFailureInfo int: the named bit within its octet, octets little-endian. */
    private static int bcMask(int bit) {
        return (0x80 >> (bit % 8)) << (8 * (bit / 8));
    }
}
