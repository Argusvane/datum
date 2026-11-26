package com.argusvane.datum.pdf.verify;

import java.security.cert.CertStore;
import java.security.cert.PKIXRevocationChecker;
import java.security.cert.X509Certificate;
import java.util.EnumSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/**
 * How {@link PdfVerifier} decides that a signer or a timestamp authority is {@code trusted}: which anchors a
 * chain must reach, whether the chain is checked for revocation, and at what time it must hold.
 *
 * <p>The chain itself is always the JDK's PKIX path build ({@code CertPathBuilder "PKIX"}: signatures, validity, CA
 * constraints). The policy chooses only the inputs the JDK exposes for it:
 * <ul>
 *   <li>{@link #anchors} the trust anchors; by default the configured ones ({@link PdfTrust#anchors()},
 *       {@code datum.pdf.signing.trust-anchors});</li>
 *   <li>{@link #revocationChecking()} on adds the JDK's own {@link PKIXRevocationChecker} (OCSP first, then CRLs, as the
 *       JDK does by default), set up by {@link #configureRevocation} (its options, an OCSP responder) and fed the
 *       {@link #certStores()} (CRLs the host holds). A chain whose revocation status cannot be learnt fails, unless the
 *       policy chose {@code SOFT_FAIL}. Network fetching, its timeouts and CRL distribution points are the JDK's
 *       settings ({@code com.sun.security.enableCRLDP}, {@code com.sun.security.ocsp.timeout}, ...);</li>
 *   <li>{@link #validationTime()}: {@link ValidationTime#NOW} judges every chain at the verifier's clock;
 *       {@link ValidationTime#SIGNING_TIME} judges a signer's chain at the time its timestamp proves, when the signature
 *       carries a timestamp that verified and whose authority is this server's or trusted; a signature without one is
 *       judged now. The signature's own {@code /M} signing time is the signer's claim and is never used. A timestamp
 *       authority's chain is always judged now (its genTime is its own word).</li>
 * </ul>
 *
 * <p>Revocation under {@link ValidationTime#SIGNING_TIME} is checked at the proven time too: the JDK takes only a CRL or an
 * OCSP reply that was valid at that time. Today's CRL is not, so a chain the timestamp moves back needs the revocation data
 * that was current when it signed (archived CRLs in {@link #certStores()}); without it the status cannot be learnt and the
 * chain fails closed ({@code unknown}), never trusted. A chain judged now (no proven time) uses current data as usual.
 *
 * <p>The default ({@link #standard()}) is the behaviour before the seam existed: the configured anchors, no revocation
 * checking, judged now. The verify report names the policy it was made under ({@link PdfVerification#trustPolicy()}).
 */
public interface PdfTrustPolicy {

    /** When a chain must hold. */
    enum ValidationTime {
        /** At the verifier's clock. */
        NOW("now"),
        /** At the time a verified, placed timestamp proves for the signature; now when there is none. */
        SIGNING_TIME("signing-time");

        private final String word;

        ValidationTime(String word) {
            this.word = word;
        }

        /** The word the report and the configuration use. */
        public String word() {
            return word;
        }
    }

    /** The name the verify report carries, so a report says which rules made it. */
    String name();

    /**
     * The trust anchors a chain must reach.
     *
     * @param trust what the host configured; its {@link PdfTrust#anchors()} is the default answer
     */
    default List<X509Certificate> anchors(PdfTrust trust) {
        return trust.anchors();
    }

    /** Whether a chain to an anchor is checked for revocation by the JDK's PKIX revocation checker. */
    default boolean revocationChecking() {
        return false;
    }

    /**
     * Sets up the JDK's revocation checker before a path build, when {@link #revocationChecking()} is on: its options
     * ({@code PREFER_CRLS}, {@code NO_FALLBACK}, {@code ONLY_END_ENTITY}, {@code SOFT_FAIL}), an OCSP responder, OCSP
     * extensions. The default leaves it as the JDK makes it.
     */
    default void configureRevocation(PKIXRevocationChecker checker) {
    }

    /** Certificate stores added to every path build: CRLs (and intermediates) the host holds. */
    default List<CertStore> certStores() {
        return List.of();
    }

    /** When a signer's chain must hold. */
    default ValidationTime validationTime() {
        return ValidationTime.NOW;
    }

    /** The behaviour before the seam: the configured anchors, no revocation checking, judged now; named {@code default}. */
    static PdfTrustPolicy standard() {
        return builder("default").build();
    }

    /** A policy of the given name, starting from the standard rules. */
    static Builder builder(String name) {
        return new Builder(name);
    }

    /** What a report says of the policy it was made under. */
    record Summary(String name, boolean revocationChecking, String validationTime) {

        static Summary of(PdfTrustPolicy policy) {
            ValidationTime time = policy.validationTime();
            return new Summary(policy.name(), policy.revocationChecking(), (time == null ? ValidationTime.NOW : time).word());
        }
    }

    /** Builds a {@link PdfTrustPolicy}. */
    final class Builder {

        private final String name;
        private List<X509Certificate> anchors;
        private boolean revocationChecking;
        private Set<PKIXRevocationChecker.Option> revocationOptions = EnumSet.noneOf(PKIXRevocationChecker.Option.class);
        private List<CertStore> certStores = List.of();
        private ValidationTime validationTime = ValidationTime.NOW;

        private Builder(String name) {
            Objects.requireNonNull(name, "name");
            if (name.isBlank()) {
                throw new IllegalArgumentException("A trust policy needs a name: the verify report carries it.");
            }
            this.name = name.strip();
        }

        /** The anchors instead of the configured ones. */
        public Builder anchors(List<X509Certificate> anchors) {
            this.anchors = List.copyOf(anchors);
            return this;
        }

        /** Revocation checking through the JDK's PKIX revocation checker, with these options. */
        public Builder revocationChecking(boolean on, PKIXRevocationChecker.Option... options) {
            this.revocationChecking = on;
            this.revocationOptions = options.length == 0 ? EnumSet.noneOf(PKIXRevocationChecker.Option.class) : EnumSet.copyOf(List.of(options));
            return this;
        }

        /** Stores of CRLs or intermediates every path build may use. */
        public Builder certStores(List<CertStore> stores) {
            this.certStores = List.copyOf(stores);
            return this;
        }

        public Builder validationTime(ValidationTime time) {
            this.validationTime = Objects.requireNonNull(time, "time");
            return this;
        }

        public PdfTrustPolicy build() {
            return new Built(name, anchors, revocationChecking, Set.copyOf(revocationOptions), certStores, validationTime);
        }
    }

    /** What {@link Builder} makes. */
    record Built(String name, List<X509Certificate> fixedAnchors, boolean revocationChecking, Set<PKIXRevocationChecker.Option> revocationOptions,
                 List<CertStore> certStores, ValidationTime validationTime) implements PdfTrustPolicy {

        @Override
        public List<X509Certificate> anchors(PdfTrust trust) {
            return fixedAnchors != null ? fixedAnchors : trust.anchors();
        }

        @Override
        public void configureRevocation(PKIXRevocationChecker checker) {
            if (!revocationOptions.isEmpty()) {
                checker.setOptions(revocationOptions);
            }
        }
    }
}
