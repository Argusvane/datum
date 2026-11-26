package com.argusvane.datum.timestamp;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.math.BigInteger;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.bouncycastle.asn1.ASN1Boolean;
import org.bouncycastle.asn1.ASN1Encodable;
import org.bouncycastle.asn1.ASN1Encoding;
import org.bouncycastle.asn1.ASN1Integer;
import org.bouncycastle.asn1.ASN1ObjectIdentifier;
import org.bouncycastle.asn1.DERGeneralizedTime;
import org.bouncycastle.asn1.DERNull;
import org.bouncycastle.asn1.DEROctetString;
import org.bouncycastle.asn1.DERUTCTime;
import org.bouncycastle.asn1.DERUTF8String;

/**
 * The little DER (X.690) the timestamp server reads by hand, and the glue it writes around bytes it already has. The values it writes (integers,
 * booleans, strings, object identifiers, times) are Bouncy Castle's ASN.1 types; only the envelope that wraps
 * already-encoded bytes ({@link #tlv}, {@link #sequence}, {@link #setOf}, {@link #explicit}, {@link #implicit}) is
 * concatenation here, because a carried certificate must never be re-encoded.
 *
 * <p>Why a hand reader beside Bouncy Castle: requests and tokens are read before anything is known about them,
 * and they are refused with exact reasons (the statusString a client sees, which the host kit's TSA cases read) and exact
 * bounds. Bouncy
 * Castle's ASN.1 parser accepts and refuses different inputs (non-minimal lengths, long object identifiers,
 * trailing bytes) with its own messages, so the refusal bytes would drift. Tokens are generated with Bouncy
 * Castle; see {@link TimestampAuthority}.
 *
 * <p>Single-byte tags and definite lengths only, which is all DER allows for these structures; anything else
 * is refused with {@link IllegalArgumentException}. Reading costs time in proportion to the bytes read: every
 * element is bounded by its parent, nothing recurses, and an object identifier is refused past
 * {@link #MAX_OID_BYTES}, or with an arc past {@link #MAX_ARC_BYTES}, before any arithmetic.
 */
final class Der {

    static final int BOOLEAN = 0x01;
    static final int INTEGER = 0x02;
    static final int BIT_STRING = 0x03;
    static final int OCTET_STRING = 0x04;
    static final int NULL = 0x05;
    static final int OID = 0x06;
    static final int UTF8_STRING = 0x0c;
    static final int UTC_TIME = 0x17;
    static final int GENERALIZED_TIME = 0x18;
    static final int SEQUENCE = 0x30;
    static final int SET = 0x31;

    /** The longest object identifier read, in content bytes. */
    static final int MAX_OID_BYTES = 64;

    /** The longest arc read, in bytes: 140 bits, room for a 2.25 UUID arc. */
    static final int MAX_ARC_BYTES = 20;

    private static final Pattern DOTTED = Pattern.compile("^([0-2])\\.(0|[1-9][0-9]*)(\\.(0|[1-9][0-9]*))*$");
    private static final DateTimeFormatter GENERALIZED = DateTimeFormatter.ofPattern("uuuuMMddHHmmss").withZone(ZoneOffset.UTC);
    private static final DateTimeFormatter UTC = DateTimeFormatter.ofPattern("uuMMddHHmmss").withZone(ZoneOffset.UTC);
    private static final BigInteger EIGHTY = BigInteger.valueOf(80);

    private Der() {
    }

    /** One element's tag and bounds: its tag byte, where it starts, where its contents start, and the end. */
    record Node(int tag, int offset, int start, int end) {
    }

    // ---- writing ---------------------------------------------------------------------------------------------

    /** An element: a tag byte and its contents. */
    static byte[] tlv(int tag, byte[] contents) {
        byte[] length = length(contents.length);
        byte[] out = new byte[1 + length.length + contents.length];
        out[0] = (byte) tag;
        System.arraycopy(length, 0, out, 1, length.length);
        System.arraycopy(contents, 0, out, 1 + length.length, contents.length);
        return out;
    }

    /** A SEQUENCE of encoded elements. */
    static byte[] sequence(byte[]... elements) {
        return tlv(SEQUENCE, concat(elements));
    }

    /** A SET OF encoded elements, sorted by their encodings as DER asks (X.690 11.6: bytewise, unsigned). */
    static byte[] setOf(byte[]... elements) {
        byte[][] sorted = elements.clone();
        Arrays.sort(sorted, Arrays::compareUnsigned);
        return tlv(SET, concat(sorted));
    }

    /** An INTEGER from a non-negative long. */
    static byte[] integer(long value) {
        if (value < 0) {
            throw new IllegalArgumentException("DER: negative integers are not written here.");
        }
        return encode(new ASN1Integer(value));
    }

    /** A non-negative INTEGER from its big-endian bytes. */
    static byte[] unsigned(byte[] bytes) {
        return encode(new ASN1Integer(new BigInteger(1, bytes)));
    }

    /** A BOOLEAN. */
    static byte[] bool(boolean value) {
        return encode(ASN1Boolean.getInstance(value));
    }

    /** A NULL. */
    static byte[] nul() {
        return encode(DERNull.INSTANCE);
    }

    /** An OCTET STRING. */
    static byte[] octetString(byte[] bytes) {
        return encode(new DEROctetString(bytes));
    }

    /** A UTF8String. */
    static byte[] utf8(String text) {
        return encode(new DERUTF8String(text));
    }

    /** An OBJECT IDENTIFIER from its dotted text; arcs of any size up to the reader's bounds. */
    static byte[] oid(String dotted) {
        if (!validOid(dotted)) {
            throw new IllegalArgumentException(String.format("DER: %s is not an object identifier.", dotted));
        }
        return encode(new ASN1ObjectIdentifier(dotted));
    }

    /**
     * Whether text is a dotted object identifier DER can write and this reader reads back: at most
     * {@link #MAX_OID_BYTES} encoded, no arc over {@link #MAX_ARC_BYTES}.
     */
    static boolean validOid(String dotted) {
        if (dotted == null || dotted.length() > 400) {
            return false;
        }
        Matcher match = DOTTED.matcher(dotted);
        if (!match.matches()) {
            return false;
        }
        // Under 0 and 1 the second arc is below 40.
        if (!match.group(1).equals("2") && (match.group(2).length() > 2 || Integer.parseInt(match.group(2)) >= 40)) {
            return false;
        }
        // 42 decimal digits stay below 2^140, the largest arc read.
        for (String arc : dotted.split("\\.")) {
            if (arc.length() > 42) {
                return false;
            }
        }
        byte[] encoded;
        try {
            encoded = encode(new ASN1ObjectIdentifier(dotted));
        } catch (IllegalArgumentException e) {
            return false;
        }
        int header = encoded[1] < 0 ? 2 + (encoded[1] & 0x7f) : 2;
        return encoded.length - header <= MAX_OID_BYTES;
    }

    /**
     * A GeneralizedTime in UTC: seconds, and milliseconds when asked (trailing zeros dropped; none written for
     * {@code null} or 0).
     */
    static byte[] generalizedTime(long seconds, Integer milliseconds) {
        StringBuilder text = new StringBuilder(GENERALIZED.format(Instant.ofEpochSecond(seconds)));
        if (milliseconds != null && milliseconds > 0) {
            String fraction = String.format("%03d", milliseconds).replaceAll("0+$", "");
            text.append('.').append(fraction);
        }
        return encode(new DERGeneralizedTime(text.append('Z').toString()));
    }

    /** A UTCTime (years 1950 to 2049), as CMS's signingTime takes it. */
    static byte[] utcTime(long seconds) {
        return encode(new DERUTCTime(UTC.format(Instant.ofEpochSecond(seconds)) + "Z"));
    }

    /** An explicit context tag [n] around encoded elements. */
    static byte[] explicit(int number, byte[] encoded) {
        return tlv(0xa0 | number, encoded);
    }

    /** An implicit context tag [n] in place of an element's own tag; the constructed bit is kept. */
    static byte[] implicit(int number, byte[] encoded) {
        Node node = read(encoded, 0, encoded.length);
        boolean constructed = (encoded[0] & 0x20) != 0;
        return tlv(0x80 | (constructed ? 0x20 : 0) | number, contents(encoded, node));
    }

    // ---- reading ---------------------------------------------------------------------------------------------

    /**
     * One element's tag and bounds.
     *
     * @throws IllegalArgumentException when the bytes there are not a DER element inside the limit
     */
    static Node read(byte[] der, int offset, int limit) {
        if ((long) offset + 2 > limit) {
            throw new IllegalArgumentException("DER: truncated.");
        }
        int tag = der[offset] & 0xff;
        if ((tag & 0x1f) == 0x1f) {
            throw new IllegalArgumentException("DER: multi-byte tags are not read.");
        }
        int first = der[offset + 1] & 0xff;
        long start = offset + 2L;
        long length;
        if (first < 0x80) {
            length = first;
        } else {
            int count = first & 0x7f;
            if (count == 0 || count > 4 || start + count > limit) {
                throw new IllegalArgumentException("DER: bad length.");
            }
            length = 0;
            for (int i = 0; i < count; i++) {
                length = (length << 8) | (der[(int) start + i] & 0xff);
            }
            if (length < 0x80 || (count > 1 && der[(int) start] == 0)) {
                throw new IllegalArgumentException("DER: a length not in its shortest form.");
            }
            start += count;
        }
        if (start + length > limit) {
            throw new IllegalArgumentException("DER: an element runs past its parent.");
        }
        return new Node(tag, offset, (int) start, (int) (start + length));
    }

    /** The one element the bytes hold, nothing after it. */
    static Node readAll(byte[] der) {
        Node node = read(der, 0, der.length);
        if (node.end() != der.length) {
            throw new IllegalArgumentException("DER: bytes after the element.");
        }
        return node;
    }

    /** The elements inside a constructed element, in order. */
    static List<Node> children(byte[] der, Node node) {
        if ((der[node.offset()] & 0x20) == 0) {
            throw new IllegalArgumentException("DER: a primitive element has no children.");
        }
        List<Node> children = new ArrayList<>();
        int offset = node.start();
        while (offset < node.end()) {
            Node child = read(der, offset, node.end());
            children.add(child);
            offset = child.end();
        }
        return children;
    }

    /** An element's contents. */
    static byte[] contents(byte[] der, Node node) {
        return Arrays.copyOfRange(der, node.start(), node.end());
    }

    /** An element whole, tag and length included. */
    static byte[] raw(byte[] der, Node node) {
        return Arrays.copyOfRange(der, node.offset(), node.end());
    }

    /**
     * An OBJECT IDENTIFIER's dotted text.
     *
     * @throws IllegalArgumentException when it is not one, or is longer than the reader's bounds
     */
    static String readOid(byte[] der, Node node) {
        if (node.tag() != OID) {
            throw new IllegalArgumentException("DER: not an object identifier.");
        }
        byte[] bytes = contents(der, node);
        if (bytes.length == 0 || (bytes[bytes.length - 1] & 0x80) != 0) {
            throw new IllegalArgumentException("DER: a malformed object identifier.");
        }
        // Bounded before any arithmetic: requests are read before anything else is known about them.
        if (bytes.length > MAX_OID_BYTES) {
            throw new IllegalArgumentException(String.format("DER: an object identifier longer than %d bytes.", MAX_OID_BYTES));
        }
        int run = 0;
        for (byte b : bytes) {
            run = (b & 0x80) != 0 ? run + 1 : 0;
            if (run >= MAX_ARC_BYTES) {
                throw new IllegalArgumentException(String.format("DER: an object identifier arc longer than %d bytes.", MAX_ARC_BYTES));
            }
        }
        List<BigInteger> arcs = new ArrayList<>();
        BigInteger current = BigInteger.ZERO;
        boolean fresh = true;
        for (byte b : bytes) {
            int value = b & 0xff;
            if (fresh && value == 0x80) {
                throw new IllegalArgumentException("DER: an object identifier arc not in its shortest form.");
            }
            current = current.shiftLeft(7).or(BigInteger.valueOf(value & 0x7f));
            fresh = false;
            if ((value & 0x80) == 0) {
                arcs.add(current);
                current = BigInteger.ZERO;
                fresh = true;
            }
        }
        BigInteger first = arcs.get(0);
        StringBuilder out = new StringBuilder();
        if (first.compareTo(EIGHTY) < 0) {
            out.append(first.intValue() / 40).append('.').append(first.intValue() % 40);
        } else {
            out.append("2.").append(first.subtract(EIGHTY));
        }
        for (int i = 1; i < arcs.size(); i++) {
            out.append('.').append(arcs.get(i));
        }
        return out.toString();
    }

    /** A non-negative INTEGER's value, when it fits in seven bytes. */
    static long readSmallInteger(byte[] der, Node node) {
        if (node.tag() != INTEGER) {
            throw new IllegalArgumentException("DER: not an integer.");
        }
        byte[] bytes = contents(der, node);
        if (bytes.length == 0 || bytes.length > 7 || (bytes[0] & 0xff) >= 0x80) {
            throw new IllegalArgumentException("DER: an integer out of range.");
        }
        long value = 0;
        for (byte b : bytes) {
            value = (value << 8) | (b & 0xff);
        }
        return value;
    }

    /** Whether a BOOLEAN is TRUE (any non-zero octet, X.690 8.2.2: a request is read as BER on this point). */
    static boolean readBoolean(byte[] der, Node node) {
        byte[] bytes = contents(der, node);
        if (node.tag() != BOOLEAN || bytes.length != 1) {
            throw new IllegalArgumentException("DER: not a boolean.");
        }
        return bytes[0] != 0;
    }

    private static byte[] length(int length) {
        if (length < 0x80) {
            return new byte[] {(byte) length};
        }
        byte[] big = BigInteger.valueOf(length).toByteArray();
        int skip = big[0] == 0 ? 1 : 0;
        byte[] out = new byte[1 + big.length - skip];
        out[0] = (byte) (0x80 | (big.length - skip));
        System.arraycopy(big, skip, out, 1, big.length - skip);
        return out;
    }

    private static byte[] encode(ASN1Encodable value) {
        try {
            return value.toASN1Primitive().getEncoded(ASN1Encoding.DER);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    static byte[] concat(byte[]... parts) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] part : parts) {
            out.writeBytes(part);
        }
        return out.toByteArray();
    }
}
