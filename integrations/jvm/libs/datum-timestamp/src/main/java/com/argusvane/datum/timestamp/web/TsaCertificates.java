package com.argusvane.datum.timestamp.web;

import com.argusvane.datum.timestamp.PemCertificates;
import com.argusvane.datum.timestamp.TsaCertificateRules;
import com.argusvane.datum.timestamp.TsaKey;
import com.argusvane.datum.timestamp.TsaKeyException;
import com.argusvane.datum.timestamp.TsaKeyMaterial;
import java.nio.charset.StandardCharsets;
import java.security.cert.CertificateEncodingException;
import java.security.cert.X509Certificate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * The certificates the timestamp server publishes for verifiers (endpoint catalog {@code getTimestampCertificate},
 * {@code getTimestampCertificates}). Public whenever the server is on, whoever may use it: a verifier needs them and a
 * certificate is never secret.
 *
 * <p>The retired chains are the ones the application hands in ({@code datum.tsa.retired-certificates}, a PEM
 * file each), so a token issued before the key was replaced still verifies against the list.
 */
public final class TsaCertificates {

    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss").withZone(ZoneOffset.UTC);

    private final TsaKeyMaterial keys;
    private final List<List<X509Certificate>> retired;

    /**
     * @param keys where the signing key comes from, asked on every request (a rotated key shows at once)
     * @param retired chains the server signed with before, each leaf first
     */
    public TsaCertificates(TsaKeyMaterial keys, List<List<X509Certificate>> retired) {
        this.keys = Objects.requireNonNull(keys, "keys");
        this.retired = retired.stream().filter(chain -> !chain.isEmpty()).map(List::copyOf).toList();
    }

    /**
     * The retired chains this list publishes, each leaf first: what a verifier of the same host places
     * besides the current key, so the PDF verifier reads the list the server publishes, also when an application replaced
     * this bean, rather than the property again.
     */
    public List<List<X509Certificate>> retired() {
        return retired;
    }

    /** The key in use, or empty when there is none the server can use. */
    public Optional<TsaKey> current() {
        try {
            return Optional.ofNullable(keys.load());
        } catch (TsaKeyException e) {
            return Optional.empty();
        }
    }

    /** {@code GET /tsa/certificate}: the chain as PEM, or with {@code der} the server's own certificate alone. */
    public TsaHttpReply certificate(boolean der) {
        Optional<TsaKey> key = current();
        if (key.isEmpty()) {
            return TsaHttpReply.plain(503, "The timestamp server has no certificate it can use.");
        }
        if (der) {
            try {
                return file(key.get().leaf().getEncoded(), "application/pkix-cert", "timestamp-server.cer");
            } catch (CertificateEncodingException e) {
                throw new IllegalStateException("The certificate cannot be encoded", e);
            }
        }
        return file(key.get().chainPem().getBytes(StandardCharsets.US_ASCII), "application/pem-certificate-chain", "timestamp-server.pem");
    }

    /**
     * {@code GET /tsa/certificates}: the one in use first, then the retired ones, each chain as PEM after comment
     * lines naming it (subject, SHA-256 fingerprint, validity, current or retired); {@code openssl ts -verify
     * -CAfile} reads the lines outside the PEM blocks as comments.
     */
    public TsaHttpReply certificates() {
        record Listed(List<X509Certificate> chain, String state) {
        }
        List<Listed> chains = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        current().ifPresent(key -> {
            seen.add(key.fingerprint());
            chains.add(new Listed(key.chain(), "Current"));
        });
        for (List<X509Certificate> chain : retired) {
            if (seen.add(TsaKey.fingerprint(chain.get(0)))) {
                chains.add(new Listed(chain, "Retired"));
            }
        }
        if (chains.isEmpty()) {
            return TsaHttpReply.plain(503, "The timestamp server has no certificate.");
        }
        StringBuilder text = new StringBuilder();
        for (Listed listed : chains) {
            X509Certificate leaf = listed.chain().get(0);
            text.append("# ").append(TsaCertificateRules.subjectText(leaf).replaceAll("[\\r\\n]+", " ")).append('\n')
                .append("# SHA-256 ").append(fingerprintText(leaf)).append('\n')
                .append("# Valid ").append(TIME.format(leaf.getNotBefore().toInstant())).append(" to ")
                .append(TIME.format(leaf.getNotAfter().toInstant())).append(" UTC\n")
                .append("# ").append(listed.state()).append('\n');
            listed.chain().forEach(certificate -> text.append(TsaKey.pem(certificate)));
            text.append('\n');
        }
        return file(text.toString().getBytes(StandardCharsets.US_ASCII), "application/x-pem-file", "timestamp-server-certificates.pem");
    }

    /** The fingerprint as people read it: colon-separated uppercase pairs. */
    static String fingerprintText(X509Certificate certificate) {
        String hex = TsaKey.fingerprint(certificate).toUpperCase(java.util.Locale.ROOT);
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < hex.length(); i += 2) {
            if (i > 0) {
                out.append(':');
            }
            out.append(hex, i, i + 2);
        }
        return out.toString();
    }

    /**
     * The certificates in PEM text, in order.
     *
     * @throws TsaKeyException when the text holds none or cannot be read
     */
    public static List<X509Certificate> parsePem(String pem) {
        List<X509Certificate> out;
        try {
            out = PemCertificates.read(pem);
        } catch (IllegalArgumentException e) {
            throw new TsaKeyException("A retired timestamp certificate cannot be read: " + e.getMessage(), e);
        }
        if (out.isEmpty()) {
            throw new TsaKeyException("A retired timestamp certificate file holds no certificate.");
        }
        return out;
    }

    private static TsaHttpReply file(byte[] body, String type, String name) {
        return new TsaHttpReply(200, type, Map.of(
            "Content-Disposition", "inline; filename=\"" + name + "\"",
            // Replaced keys show at once.
            "Cache-Control", "no-cache",
            "X-Content-Type-Options", "nosniff"), body);
    }
}
