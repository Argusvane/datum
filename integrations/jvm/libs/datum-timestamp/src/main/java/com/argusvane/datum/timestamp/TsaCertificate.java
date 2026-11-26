package com.argusvane.datum.timestamp;

import java.util.ArrayList;
import java.util.List;

/**
 * The timestamp server's certificate, as RFC 3161 and its tokens need it.
 *
 * <p>Reads from the certificate's DER its issuer and subject names and its serial number, whole, and its
 * extended key usage with the critical flag as written (not as a JCA provider reports it). RFC 3161 section 2.3:
 * the certificate names exactly one extended key usage, id-kp-timeStamping, and marks the extension critical.
 */
final class TsaCertificate {

    /** The extended key usage extension (id-ce-extKeyUsage). */
    static final String EXT_KEY_USAGE = "2.5.29.37";

    /** The time stamping purpose (id-kp-timeStamping). */
    static final String TIME_STAMPING = "1.3.6.1.5.5.7.3.8";

    /** The extended key usage as written: critical, and its purposes. */
    record ExtendedKeyUsage(boolean critical, List<String> purposes) {
    }

    private final byte[] issuer;
    private final byte[] subject;
    private final byte[] serial;
    private final ExtendedKeyUsage extendedKeyUsage;

    /**
     * Reads a certificate.
     *
     * @throws IllegalArgumentException when its DER cannot be read
     */
    TsaCertificate(byte[] der) {
        Der.Node root = Der.readAll(der);
        List<Der.Node> top = Der.children(der, root);
        Der.Node tbs = top.isEmpty() ? null : top.get(0);
        if (tbs == null || tbs.tag() != Der.SEQUENCE) {
            throw new IllegalArgumentException("DER: not a certificate.");
        }
        List<Der.Node> fields = new ArrayList<>(Der.children(der, tbs));
        // An explicit [0] version comes first in every v3 certificate.
        if (!fields.isEmpty() && fields.get(0).tag() == 0xa0) {
            fields.remove(0);
        }
        if (fields.size() < 6) {
            throw new IllegalArgumentException("DER: not a certificate.");
        }
        this.serial = Der.raw(der, fields.get(0));
        this.issuer = Der.raw(der, fields.get(2));
        this.subject = Der.raw(der, fields.get(4));
        ExtendedKeyUsage usage = null;
        for (Der.Node field : fields.subList(6, fields.size())) {
            if (field.tag() != 0xa3) {
                continue;
            }
            List<Der.Node> wrapped = Der.children(der, field);
            List<Der.Node> extensions = wrapped.isEmpty() ? List.of() : Der.children(der, wrapped.get(0));
            for (Der.Node extension : extensions) {
                List<Der.Node> parts = Der.children(der, extension);
                if (parts.size() < 2) {
                    throw new IllegalArgumentException("DER: a malformed extension.");
                }
                if (!Der.readOid(der, parts.get(0)).equals(EXT_KEY_USAGE)) {
                    continue;
                }
                boolean critical = parts.size() == 3 && Der.readBoolean(der, parts.get(1));
                byte[] value = Der.contents(der, parts.get(parts.size() - 1));
                List<String> purposes = new ArrayList<>();
                for (Der.Node purpose : Der.children(value, Der.readAll(value))) {
                    purposes.add(Der.readOid(value, purpose));
                }
                usage = new ExtendedKeyUsage(critical, List.copyOf(purposes));
            }
        }
        this.extendedKeyUsage = usage;
    }

    /** The issuer Name, DER. */
    byte[] issuer() {
        return issuer.clone();
    }

    /** The subject Name, DER. */
    byte[] subject() {
        return subject.clone();
    }

    /** The serial number INTEGER, DER. */
    byte[] serial() {
        return serial.clone();
    }

    /** The extended key usage as written, or {@code null} when the certificate names none. */
    ExtendedKeyUsage extendedKeyUsage() {
        return extendedKeyUsage;
    }
}
