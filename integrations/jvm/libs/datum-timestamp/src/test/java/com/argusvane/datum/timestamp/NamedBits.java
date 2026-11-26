package com.argusvane.datum.timestamp;

import java.util.Arrays;

/**
 * The independent expectation for a PKIFailureInfo BIT STRING: DER's named-bit rule written out by hand (trailing
 * zero bits dropped, so badAlg is exactly {@code 03 02 07 80}), so the tests compare Bouncy Castle's
 * {@code PKIFailureInfo} output against something that does not come from Bouncy Castle.
 */
final class NamedBits {

    private NamedBits() {
    }

    /** A BIT STRING of named bits; the arguments are the numbers of the bits set (0 is the first). */
    static byte[] of(int... bits) {
        if (bits.length == 0) {
            return Der.tlv(Der.BIT_STRING, new byte[] {0});
        }
        int highest = Arrays.stream(bits).max().getAsInt();
        byte[] bytes = new byte[highest / 8 + 2];
        bytes[0] = (byte) (7 - highest % 8);
        for (int bit : bits) {
            bytes[1 + bit / 8] |= (byte) (0x80 >> (bit % 8));
        }
        return Der.tlv(Der.BIT_STRING, bytes);
    }
}
