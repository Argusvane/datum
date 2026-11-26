package com.argusvane.datum.timestamp;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.Objects;
import org.bouncycastle.asn1.ASN1Encoding;
import org.bouncycastle.asn1.cmp.PKIFailureInfo;
import org.bouncycastle.asn1.cmp.PKIFreeText;
import org.bouncycastle.asn1.cmp.PKIStatus;
import org.bouncycastle.asn1.cmp.PKIStatusInfo;
import org.bouncycastle.asn1.tsp.TimeStampResp;

/**
 * Why a timestamp request is refused, as RFC 3161 names it (section 2.4.2, PKIFailureInfo).
 *
 * <p>Carries the PKIFailureInfo bit the reply states ({@code FAIL_*}), the words of its statusString and the
 * HTTP status the reply goes out with: 400 when the request is at fault, 503 when the server is. Thrown inside a
 * {@link TimestampRefusedException}; {@link #toResponse()} is the TimeStampResp a client reads.
 *
 * @param failInfo the PKIFailureInfo bit ({@code FAIL_*})
 * @param message the statusString, in plain English (it goes to a machine)
 */
public record TimestampRefusal(int failInfo, String message) {

    /** PKIFailureInfo badAlg: an unrecognised or unsupported algorithm. */
    public static final int FAIL_BAD_ALG = 0;

    /** PKIFailureInfo badRequest: a transaction not permitted or supported. */
    public static final int FAIL_BAD_REQUEST = 2;

    /** PKIFailureInfo badDataFormat: the data submitted has the wrong format. */
    public static final int FAIL_BAD_DATA_FORMAT = 5;

    /** PKIFailureInfo timeNotAvailable: the TSA's time source is not available. */
    public static final int FAIL_TIME_NOT_AVAILABLE = 14;

    /** PKIFailureInfo unacceptedPolicy: the requested policy is not supported. */
    public static final int FAIL_UNACCEPTED_POLICY = 15;

    /** PKIFailureInfo unacceptedExtension: the requested extension is not supported. */
    public static final int FAIL_UNACCEPTED_EXTENSION = 16;

    /** PKIFailureInfo systemFailure: the request cannot be handled. */
    public static final int FAIL_SYSTEM_FAILURE = 25;

    public TimestampRefusal {
        Objects.requireNonNull(message, "message");
        if (failInfo < 0 || failInfo > 31) {
            throw new IllegalArgumentException("A PKIFailureInfo bit is 0 to 31: " + failInfo);
        }
    }

    /** The HTTP status the reply goes out with: 503 when the server is at fault, 400 otherwise. */
    public int httpStatus() {
        return failInfo == FAIL_SYSTEM_FAILURE || failInfo == FAIL_TIME_NOT_AVAILABLE ? 503 : 400;
    }

    /** The failure's name, as RFC 3161 spells it. */
    public String failName() {
        return switch (failInfo) {
            case FAIL_BAD_ALG -> "badAlg";
            case FAIL_BAD_REQUEST -> "badRequest";
            case FAIL_BAD_DATA_FORMAT -> "badDataFormat";
            case FAIL_TIME_NOT_AVAILABLE -> "timeNotAvailable";
            case FAIL_UNACCEPTED_POLICY -> "unacceptedPolicy";
            case FAIL_UNACCEPTED_EXTENSION -> "unacceptedExtension";
            default -> "systemFailure";
        };
    }

    /**
     * A PKIFailureInfo bit's name as RFC 3161 and RFC 4210 spell it, for a client reading a refusal; a bit with no name
     * there is {@code failInfo bit <n>} (unlike {@link #failName()}, which is what this server writes).
     */
    public static String nameOf(int bit) {
        return switch (bit) {
            case FAIL_BAD_ALG -> "badAlg";
            case FAIL_BAD_REQUEST -> "badRequest";
            case FAIL_BAD_DATA_FORMAT -> "badDataFormat";
            case FAIL_TIME_NOT_AVAILABLE -> "timeNotAvailable";
            case FAIL_UNACCEPTED_POLICY -> "unacceptedPolicy";
            case FAIL_UNACCEPTED_EXTENSION -> "unacceptedExtension";
            case 17 -> "addInfoNotAvailable";
            case FAIL_SYSTEM_FAILURE -> "systemFailure";
            default -> "failInfo bit " + bit;
        };
    }

    /**
     * Bouncy Castle's {@link PKIFailureInfo} constant for this bit: those are bit masks in BC's own per-byte layout,
     * which its {@code PKIFailureInfo(int)} constructor writes as DER's named-bit string (trailing zero bits
     * dropped: badAlg is exactly {@code 03 02 07 80}), while {@code FAIL_*} are RFC 3161's bit numbers.
     */
    int mask() {
        // BC's layout for any bit 0..31 (the record accepts them all), so the reply carries the bit the event and
        // the HTTP status report; an unknown bit is not turned into systemFailure.
        return (0x80 >> (failInfo % 8)) << (8 * (failInfo / 8));
    }

    /**
     * The refusal as a TimeStampResp: {@code SEQ{SEQ{INTEGER 2 (rejection), SEQ{UTF8String message},
     * BIT STRING failInfo}}} (RFC 3161 section 2.4.2).
     */
    public byte[] toResponse() {
        PKIStatusInfo status = new PKIStatusInfo(PKIStatus.rejection, new PKIFreeText(message), new PKIFailureInfo(mask()));
        try {
            return new TimeStampResp(status, null).getEncoded(ASN1Encoding.DER);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
