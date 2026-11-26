package com.argusvane.datum.pdf.verify;

import java.security.cert.X509Certificate;
import java.time.Clock;
import java.util.List;
import java.util.Objects;
import java.util.function.Supplier;

/**
 * What the verifier places signers against: the server's signing certificates (current and retired), the trust
 * anchors, and its timestamp server's certificates (current and retired).
 *
 * <p>This host stores nothing, so the retired certificates are configuration ({@code datum.pdf.signing.retired-certificates},
 * {@code datum.tsa.retired-certificates}) and the current ones are the configured signer's and timestamp authority's.
 * A signer is placed by its certificate's fingerprint, never by its name.
 *
 * @param siteSigners the server's current PDF signing certificate(s), asked on every verification
 * @param retiredSigners certificates the server signed with before
 * @param anchors trusted certificates: a signer or a timestamp authority that chains to one is {@code trusted}
 * @param siteTimestampCertificates the server's own timestamp authority's certificates, current and retired
 * @param clock what "now" is for validity and chains
 */
public record PdfTrust(Supplier<List<X509Certificate>> siteSigners, List<X509Certificate> retiredSigners, List<X509Certificate> anchors,
                       Supplier<List<X509Certificate>> siteTimestampCertificates, Clock clock) {

    public PdfTrust {
        siteSigners = siteSigners == null ? List::of : siteSigners;
        retiredSigners = retiredSigners == null ? List.of() : List.copyOf(retiredSigners);
        anchors = anchors == null ? List.of() : List.copyOf(anchors);
        siteTimestampCertificates = siteTimestampCertificates == null ? List::of : siteTimestampCertificates;
        Objects.requireNonNull(clock, "clock");
    }

    /**
     * This trust with the server's current signing certificate among its site signers, asked afresh on every verification
     * as the given supplier is. The PDF service makes its own verifier's trust this way, and a host that builds a verifier
     * for it must too, or the server's own seal reads as unknown.
     */
    public PdfTrust withSiteSigner(X509Certificate current) {
        Objects.requireNonNull(current, "current");
        Supplier<List<X509Certificate>> given = siteSigners;
        return new PdfTrust(() -> {
            List<X509Certificate> signers = new java.util.ArrayList<>(given.get() == null ? List.of() : given.get());
            signers.add(current);
            return signers;
        }, retiredSigners, anchors, siteTimestampCertificates, clock);
    }

    /** Nothing known: every signer is self-signed or unknown. */
    public static PdfTrust none(Clock clock) {
        return new PdfTrust(List::of, List.of(), List.of(), List::of, clock);
    }
}
