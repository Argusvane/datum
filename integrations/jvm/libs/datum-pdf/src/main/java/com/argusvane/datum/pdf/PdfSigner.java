package com.argusvane.datum.pdf;

import java.security.cert.CertificateEncodingException;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/**
 * The server's signing key: the one cryptographic step the host keeps for itself in the two-call
 * protocol. The kernel prepares the PDF and hands out {@code toBeSigned} (the DER signed attributes); the signer
 * signs those bytes; the kernel embeds the value. {@link KeyStorePdfSigner} keeps the key in {@code java.security};
 * an HSM or cloud KMS implements this interface over the same bytes (or their SHA-256, the handoff's
 * {@code toBeSignedDigest}).
 *
 * <p>The contract the service holds a signer to before the value reaches {@code complete} (a signer's value is never
 * embedded on its word): for {@code RSASSA-PKCS1-v1_5-SHA256} a PKCS#1 v1.5 signature
 * with SHA-256; for {@code ECDSA-P256-SHA256} and {@code ECDSA-P384-SHA256} an ECDSA signature with SHA-256 in DER
 * (a SEQUENCE of two INTEGERs, Java's {@code SHA256withECDSA}), never the fixed-width {@code r||s} (P1363) form;
 * and the value must verify over {@code toBeSigned} with the leaf certificate's key.
 */
public interface PdfSigner {

    /** The certificate chain, the signer's first and its issuers after. */
    List<X509Certificate> chain();

    /**
     * Signs the DER signed attributes.
     *
     * @param toBeSigned the bytes to sign, as the kernel handed them out
     * @param signatureAlgorithm the handoff's {@code signatureAlgorithm}: {@code RSASSA-PKCS1-v1_5-SHA256},
     *     {@code ECDSA-P256-SHA256} or {@code ECDSA-P384-SHA256}
     * @return the raw signature value (DER for ECDSA)
     * @throws PdfException ({@code signature}) when the key cannot sign for that algorithm
     */
    byte[] sign(byte[] toBeSigned, String signatureAlgorithm);

    /** The leaf certificate. */
    default X509Certificate leaf() {
        return chain().get(0);
    }

    /** The chain as the kernel takes it: DER, base64, leaf first. */
    default List<String> certificatesBase64() {
        List<String> out = new ArrayList<>();
        for (X509Certificate certificate : chain()) {
            try {
                out.add(Base64.getEncoder().encodeToString(certificate.getEncoded()));
            } catch (CertificateEncodingException e) {
                throw PdfException.signature("The signing certificate cannot be encoded.", e);
            }
        }
        return out;
    }
}
