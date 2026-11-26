package com.argusvane.datum.timestamp;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.StringReader;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;
import org.bouncycastle.cert.X509CertificateHolder;
import org.bouncycastle.openssl.PEMParser;

/**
 * The one reader of PEM certificate text in the Java host (the timestamp keys, the retired timestamp certificates,
 * the PDF trust files): Bouncy Castle's {@link PEMParser} finds the blocks, so comment lines and other blocks (a
 * private key beside its certificate) are passed over, and the JDK's {@link CertificateFactory} makes the
 * certificates. A block that does not read is an error, not skipped: a trust file or a key file with a damaged
 * certificate stops the start, naming the problem, rather than quietly trusting less than the operator wrote.
 */
public final class PemCertificates {

    private PemCertificates() {
    }

    private static final java.util.regex.Pattern BLOCK = java.util.regex.Pattern.compile(
        "-----BEGIN ((?:X509 |TRUSTED )?CERTIFICATE)-----.*?-----END \\1-----", java.util.regex.Pattern.DOTALL);
    private static final java.util.regex.Pattern BEGIN = java.util.regex.Pattern.compile("-----BEGIN (?:X509 |TRUSTED )?CERTIFICATE-----");

    /**
     * Every certificate in the text, in order; none for a null or certificate-free text.
     *
     * @throws IllegalArgumentException when the text is not readable PEM or a certificate block is damaged
     */
    public static List<X509Certificate> read(String pem) {
        List<X509Certificate> out = new ArrayList<>();
        if (pem == null) {
            return out;
        }
        // Only certificate blocks are read; a block of any other type (a key, a CSR) is not this reader's concern and is
        // skipped, as the old trust reader did. Lines are stripped first so an indented block is read, not dropped, and a
        // BEGIN line without its END (or a damaged body) fails rather than trusting fewer certificates in silence.
        String text = pem.lines().map(String::strip).collect(java.util.stream.Collectors.joining("\n"));
        java.util.regex.Matcher blocks = BLOCK.matcher(text);
        int found = 0;
        try {
            CertificateFactory factory = CertificateFactory.getInstance("X.509");
            while (blocks.find()) {
                found++;
                try (PEMParser parser = new PEMParser(new StringReader(blocks.group()))) {
                    Object item = parser.readObject();
                    if (!(item instanceof X509CertificateHolder holder)) {
                        throw new IllegalArgumentException("The PEM text cannot be read: a certificate block is not a certificate.");
                    }
                    out.add((X509Certificate) factory.generateCertificate(new ByteArrayInputStream(holder.getEncoded())));
                }
            }
        } catch (IOException | CertificateException e) {
            throw new IllegalArgumentException("The PEM text cannot be read: " + e.getMessage(), e);
        }
        java.util.regex.Matcher begins = BEGIN.matcher(text);
        int begun = 0;
        while (begins.find()) {
            begun++;
        }
        if (begun != found) {
            throw new IllegalArgumentException("The PEM text cannot be read: a certificate block has no matching END line.");
        }
        return out;
    }
}
