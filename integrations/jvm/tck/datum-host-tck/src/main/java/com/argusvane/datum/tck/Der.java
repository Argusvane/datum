package com.argusvane.datum.tck;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.List;

/**
 * Just enough DER for the timestamp contract, so the kit needs no ASN.1 library: it writes an RFC 3161
 * {@code TimeStampReq} and reads the {@code PKIStatus} of a {@code TimeStampResp}.
 */
public final class Der {

    /** {@code AlgorithmIdentifier} of SHA-256 (2.16.840.1.101.3.4.2.1) with NULL parameters. */
    private static final byte[] SHA256 = {0x30, 0x0d, 0x06, 0x09, 0x60, (byte) 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00};

    private Der() {
    }

    /** One element: its tag, and its content bytes. */
    public record Element(int tag, byte[] content) {

        /** The elements inside a constructed element (a SEQUENCE). */
        public List<Element> children() {
            List<Element> out = new ArrayList<>();
            int at = 0;
            while (at < content.length) {
                Read read = read(content, at);
                out.add(read.element());
                at = read.next();
            }
            return out;
        }

        public BigInteger integer() {
            if (tag != 0x02) {
                throw new IllegalArgumentException("not an INTEGER: tag " + tag);
            }
            return new BigInteger(content);
        }
    }

    private record Read(Element element, int next) {
    }

    /** The outermost element of {@code der}. */
    public static Element parse(byte[] der) {
        Read read = read(der, 0);
        if (read.next() != der.length) {
            throw new IllegalArgumentException("bytes after the outermost element");
        }
        return read.element();
    }

    private static Read read(byte[] in, int at) {
        int tag = in[at] & 0xff;
        int length = in[at + 1] & 0xff;
        int start = at + 2;
        if (length > 0x80) {
            int count = length & 0x7f;
            length = 0;
            for (int i = 0; i < count; i++) {
                length = (length << 8) | (in[start + i] & 0xff);
            }
            start += count;
        } else if (length == 0x80) {
            throw new IllegalArgumentException("indefinite length is not DER");
        }
        byte[] content = java.util.Arrays.copyOfRange(in, start, start + length);
        return new Read(new Element(tag, content), start + length);
    }

    private static byte[] tlv(int tag, byte[]... parts) {
        ByteArrayOutputStream content = new ByteArrayOutputStream();
        for (byte[] part : parts) {
            content.writeBytes(part);
        }
        byte[] body = content.toByteArray();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(tag);
        if (body.length < 0x80) {
            out.write(body.length);
        } else {
            byte[] length = BigInteger.valueOf(body.length).toByteArray();
            int skip = length[0] == 0 ? 1 : 0;
            out.write(0x80 | (length.length - skip));
            out.write(length, skip, length.length - skip);
        }
        out.writeBytes(body);
        return out.toByteArray();
    }

    /**
     * A version 1 {@code TimeStampReq} over a SHA-256 digest, with a nonce and {@code certReq} TRUE (what
     * {@code openssl ts -query -sha256 -cert} sends).
     */
    public static byte[] timeStampRequest(byte[] sha256, BigInteger nonce) {
        byte[] imprint = tlv(0x30, SHA256, tlv(0x04, sha256));
        return tlv(0x30, tlv(0x02, BigInteger.ONE.toByteArray()), imprint, tlv(0x02, nonce.toByteArray()), tlv(0x01, new byte[] {(byte) 0xff}));
    }

    /** The {@code PKIStatus} of a {@code TimeStampResp} (0 granted, 1 granted with modifications, 2 rejection, ...). */
    public static int pkiStatus(byte[] timeStampResp) {
        Element response = parse(timeStampResp);
        Element statusInfo = response.children().get(0);
        return statusInfo.children().get(0).integer().intValueExact();
    }

    /** Whether {@code needle} occurs in {@code haystack}. */
    public static boolean contains(byte[] haystack, byte[] needle) {
        outer:
        for (int i = 0; i + needle.length <= haystack.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    continue outer;
                }
            }
            return true;
        }
        return false;
    }
}
