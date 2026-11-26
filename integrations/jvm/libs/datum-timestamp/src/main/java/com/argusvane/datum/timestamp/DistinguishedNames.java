package com.argusvane.datum.timestamp;

import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.bouncycastle.asn1.ASN1Encodable;
import org.bouncycastle.asn1.ASN1String;
import org.bouncycastle.asn1.x500.AttributeTypeAndValue;
import org.bouncycastle.asn1.x500.RDN;
import org.bouncycastle.asn1.x500.X500Name;

/**
 * Certificate names as Datum prints them, once: {@code CN=…, O=…, C=…}, the attributes in the reverse of their DER
 * order (most specific first) with openssl's short labels. The verify report and the timestamp server's messages
 * and health check carry this text on the wire, so the format is Datum's to keep stable.
 */
public final class DistinguishedNames {

    /** Attribute types as openssl's short names. */
    private static final Map<String, String> NAMES = Map.ofEntries(
        Map.entry("2.5.4.3", "CN"), Map.entry("2.5.4.6", "C"), Map.entry("2.5.4.7", "L"), Map.entry("2.5.4.8", "ST"),
        Map.entry("2.5.4.10", "O"), Map.entry("2.5.4.11", "OU"), Map.entry("2.5.4.5", "serialNumber"),
        Map.entry("1.2.840.113549.1.9.1", "emailAddress"), Map.entry("2.5.4.4", "SN"), Map.entry("2.5.4.42", "GN"),
        Map.entry("2.5.4.12", "title"), Map.entry("0.9.2342.19200300.100.1.25", "DC"),
        Map.entry("0.9.2342.19200300.100.1.1", "UID"), Map.entry("2.5.4.97", "organizationIdentifier"));

    private DistinguishedNames() {
    }

    /** The certificate's subject. */
    public static String subject(X509Certificate certificate) {
        return text(X500Name.getInstance(certificate.getSubjectX500Principal().getEncoded()));
    }

    /** The certificate's issuer. */
    public static String issuer(X509Certificate certificate) {
        return text(X500Name.getInstance(certificate.getIssuerX500Principal().getEncoded()));
    }

    /** A name, its attributes in the reverse of their DER order. */
    public static String text(X500Name name) {
        RDN[] rdns = name.getRDNs();
        List<String> out = new ArrayList<>();
        for (int i = rdns.length - 1; i >= 0; i--) {
            for (AttributeTypeAndValue value : rdns[i].getTypesAndValues()) {
                out.add(NAMES.getOrDefault(value.getType().getId(), value.getType().getId()) + "=" + valueText(value.getValue()));
            }
        }
        return String.join(", ", out);
    }

    /** An attribute value as text: a string as itself, anything else as BC prints it. */
    public static String valueText(ASN1Encodable value) {
        return value instanceof ASN1String text ? text.getString() : value.toString();
    }
}
