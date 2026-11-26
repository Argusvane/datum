package com.argusvane.datum.pdf.config;

import com.argusvane.datum.core.DatumConfigurationException;
import com.argusvane.datum.core.io.ResourceHandle;
import com.argusvane.datum.pdf.PdfFonts;
import com.argusvane.datum.pdf.SealPreset;
import com.argusvane.datum.timestamp.PemCertificates;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.security.cert.X509Certificate;
import java.time.Duration;
import java.util.List;
import java.util.function.Consumer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * {@code datum.pdf.*}: what {@code PdfService} is built from, as one framework-free value with its checks (integrations/jvm/README.md "Libraries and bindings"). Spring's {@code DatumPdfProperties} and
 * a Quarkus config mapping would also map onto it, so a word that names no font pack or certification level fails the
 * start with the same message on every host.
 *
 * @param enabled whether the PDF capability is on
 * @param fonts   the fonts a request carries unless the caller asks for another pack: default, standard or all
 * @param signing what verification trusts and the timestamp server for seals
 * @param seal    the seal every issued PDF gets
 * @param verifyMaxBytes the largest PDF the verify route reads, 1 MiB to 100 MiB ({@code datum.runtime.verify-max-bytes}: the key
 *                is shared with the other hosts, though the route is PDF's, so the value lives here and not with the sandbox's
 *                budgets); {@link #clampVerifyMaxBytes} makes it from a configured value
 */
public record PdfSettings(boolean enabled, String fonts, Signing signing, Seal seal, long verifyMaxBytes) {
    // Copies: one component changed, the rest kept; the canonical constructor
    // checks the result, so a copy cannot hold what a new value could not. Replaces a positional constructor call that
    // breaks whenever a component is added.

    /** A copy with {@code enabled} replaced and every other component kept. */
    public PdfSettings withEnabled(boolean value) {
        return new PdfSettings(value, fonts, signing, seal, verifyMaxBytes);
    }

    /** A copy with {@code fonts} replaced and every other component kept. */
    public PdfSettings withFonts(String value) {
        return new PdfSettings(enabled, value, signing, seal, verifyMaxBytes);
    }

    /** A copy with {@code signing} replaced and every other component kept. */
    public PdfSettings withSigning(Signing value) {
        return new PdfSettings(enabled, fonts, value, seal, verifyMaxBytes);
    }

    /** A copy with {@code seal} replaced and every other component kept. */
    public PdfSettings withSeal(Seal value) {
        return new PdfSettings(enabled, fonts, signing, value, verifyMaxBytes);
    }

    /** A copy with {@code verifyMaxBytes} replaced and every other component kept. */
    public PdfSettings withVerifyMaxBytes(long value) {
        return new PdfSettings(enabled, fonts, signing, seal, value);
    }

    public PdfSettings {
        // A word that names no pack stops here, where the settings are built, not at the first use of the pack.
        if (fonts != null) {
            fontPackOf(fonts);
        }
        signing = signing == null ? Signing.defaults() : signing;
        seal = seal == null ? Seal.defaults() : seal;
        if (verifyMaxBytes < VERIFY_MIN_BYTES || verifyMaxBytes > VERIFY_MAX_BYTES) {
            throw new IllegalArgumentException("verifyMaxBytes = " + verifyMaxBytes + " is outside [" + VERIFY_MIN_BYTES + ", "
                + VERIFY_MAX_BYTES + "]: make it with PdfSettings.clampVerifyMaxBytes.");
        }
    }

    /** The settings with the default verify cap (20 MiB). */
    public PdfSettings(boolean enabled, String fonts, Signing signing, Seal seal) {
        this(enabled, fonts, signing, seal, VERIFY_DEFAULT_BYTES);
    }

    private static final Logger LOG = LoggerFactory.getLogger(PdfSettings.class);

    /** The smallest verify cap: 1 MiB. */
    public static final long VERIFY_MIN_BYTES = 1_048_576L;
    /** The largest verify cap: 100 MiB. */
    public static final long VERIFY_MAX_BYTES = 100 * 1_048_576L;
    /** The default verify cap: 20 MiB. */
    public static final long VERIFY_DEFAULT_BYTES = 20 * 1_048_576L;
    /** The property of the verify cap, shared with the other hosts under {@code datum.runtime}. */
    public static final String VERIFY_MAX_BYTES_KEY = "datum.runtime.verify-max-bytes";

    /**
     * {@code datum.runtime.verify-max-bytes} as the cap in force: the default for none, the default (with a WARN) for a value of
     * zero or less, else the value within 1 MiB to 100 MiB, with one WARN naming the key when it is moved (the same words the
     * sandbox's limits use for a clamped budget). A WARN follows whenever a value that was set is not the one used.
     *
     * @param configured the bytes as set, or null
     */
    public static long clampVerifyMaxBytes(Long configured) {
        return clampVerifyMaxBytes(configured, message -> LOG.warn(message));
    }

    /**
     * {@link #clampVerifyMaxBytes(Long)} with the WARN text handed to {@code warnings} instead of the log, so a caller (or a
     * test) sees the exact words without a logging backend.
     *
     * @param configured the bytes as set, or null
     * @param warnings   receives the one WARN text when the value that was set is not the one used
     */
    public static long clampVerifyMaxBytes(Long configured, Consumer<String> warnings) {
        if (configured == null) {
            return VERIFY_DEFAULT_BYTES;
        }
        long used = configured <= 0 ? VERIFY_DEFAULT_BYTES : Math.max(VERIFY_MIN_BYTES, Math.min(VERIFY_MAX_BYTES, configured));
        if (used != configured) {
            warnings.accept("datum limit verifyMaxBytes = " + configured + " is outside [" + VERIFY_MIN_BYTES + ", " + VERIFY_MAX_BYTES
                + "]; using " + used + ".");
        }
        return used;
    }

    /** What an application that set nothing runs with: two fonts, no signer, no seal. */
    public static PdfSettings defaults() {
        return new PdfSettings(true, "default", Signing.defaults(), Seal.defaults(), VERIFY_DEFAULT_BYTES);
    }

    /**
     * {@code datum.pdf.signing.*}: what verification trusts and the timestamp server for seals. The signing key itself is
     * the host's (Spring: {@code datum.pdf.signing.ssl-bundle}).
     *
     * @param retiredCertificates PEM: certificates the server signed with before a rotation, or null
     * @param trustAnchors        PEM: trust anchors for signers and timestamp authorities, or null
     * @param tsa                 a named timestamp server for seals
     */
    public record Signing(ResourceHandle retiredCertificates, ResourceHandle trustAnchors, Tsa tsa) {

    /** A copy with {@code retiredCertificates} replaced and every other component kept. */
    public Signing withRetiredCertificates(ResourceHandle value) {
        return new Signing(value, trustAnchors, tsa);
    }

    /** A copy with {@code trustAnchors} replaced and every other component kept. */
    public Signing withTrustAnchors(ResourceHandle value) {
        return new Signing(retiredCertificates, value, tsa);
    }

    /** A copy with {@code tsa} replaced and every other component kept. */
    public Signing withTsa(Tsa value) {
        return new Signing(retiredCertificates, trustAnchors, value);
    }

        public Signing {
            tsa = tsa == null ? Tsa.defaults() : tsa;
        }

        public static Signing defaults() {
            return new Signing(null, null, Tsa.defaults());
        }
    }

    /**
     * {@code datum.pdf.signing.tsa.*}.
     *
     * @param url           the timestamp server's URL; empty uses the in-process authority when it is active
     * @param timeout       how long a whole request may take
     * @param bearerToken   a bearer token, or null
     * @param basicUser     an HTTP Basic user, or null
     * @param basicPassword its password, or null
     * @param policy        the {@code reqPolicy} object identifier every request carries (dotted); null or blank asks for none
     */
    public record Tsa(String url, Duration timeout, String bearerToken, String basicUser, String basicPassword, String policy) {
    // Copies: one component changed, the rest kept; the canonical constructor
    // checks the result, so a copy cannot hold what a new value could not. Replaces a positional constructor call that
    // breaks whenever a component is added.

    /** A copy with {@code url} replaced and every other component kept. */
    public Tsa withUrl(String value) {
        return new Tsa(value, timeout, bearerToken, basicUser, basicPassword, policy);
    }

    /** A copy with {@code timeout} replaced and every other component kept. */
    public Tsa withTimeout(Duration value) {
        return new Tsa(url, value, bearerToken, basicUser, basicPassword, policy);
    }

    /** A copy with {@code bearerToken} replaced and every other component kept. */
    public Tsa withBearerToken(String value) {
        return new Tsa(url, timeout, value, basicUser, basicPassword, policy);
    }

    /** A copy with {@code basicUser} replaced and every other component kept. */
    public Tsa withBasicUser(String value) {
        return new Tsa(url, timeout, bearerToken, value, basicPassword, policy);
    }

    /** A copy with {@code basicPassword} replaced and every other component kept. */
    public Tsa withBasicPassword(String value) {
        return new Tsa(url, timeout, bearerToken, basicUser, value, policy);
    }

    /** A copy with {@code policy} replaced and every other component kept. */
    public Tsa withPolicy(String value) {
        return new Tsa(url, timeout, bearerToken, basicUser, basicPassword, value);
    }

        public static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(10);

        /** A null timeout is the default; one under a second is a typo, so the start stops naming the property. */
        public Tsa {
            timeout = timeout == null ? DEFAULT_TIMEOUT : timeout;
            if (timeout.compareTo(Duration.ofSeconds(1)) < 0) {
                throw new DatumConfigurationException("datum.pdf.signing.tsa.timeout", "datum.pdf.signing.tsa.timeout must be at least 1s, not " + timeout + ".");
            }
        }

        public static Tsa defaults() {
            return new Tsa(null, DEFAULT_TIMEOUT, null, null, null, null);
        }
    }

    /**
     * {@code datum.pdf.seal.*}.
     *
     * @param enabled       whether issued PDFs are sealed with the server's key
     * @param layouts       the layouts sealed; empty for every layout
     * @param certify       noChanges, formFill, annotate or none (DocMDP P=1, 2, 3, or an approval signature)
     * @param timestamp     whether to ask a timestamp server for a token over the seal, when one is available
     * @param reason        the signature's reason
     * @param location      the signature's location
     * @param visible       false for an invisible signature, null for the default
     * @param postedAnswers whether the PDFs of posted, unstored answers are sealed with the server's key
     */
    public record Seal(boolean enabled, List<String> layouts, String certify, boolean timestamp, String reason, String location,
                       Boolean visible, boolean postedAnswers) {
    // Copies: one component changed, the rest kept; the canonical constructor
    // checks the result, so a copy cannot hold what a new value could not. Replaces a positional constructor call that
    // breaks whenever a component is added.

    /** A copy with {@code enabled} replaced and every other component kept. */
    public Seal withEnabled(boolean value) {
        return new Seal(value, layouts, certify, timestamp, reason, location, visible, postedAnswers);
    }

    /** A copy with {@code layouts} replaced and every other component kept. */
    public Seal withLayouts(List<String> value) {
        return new Seal(enabled, value, certify, timestamp, reason, location, visible, postedAnswers);
    }

    /** A copy with {@code certify} replaced and every other component kept. */
    public Seal withCertify(String value) {
        return new Seal(enabled, layouts, value, timestamp, reason, location, visible, postedAnswers);
    }

    /** A copy with {@code timestamp} replaced and every other component kept. */
    public Seal withTimestamp(boolean value) {
        return new Seal(enabled, layouts, certify, value, reason, location, visible, postedAnswers);
    }

    /** A copy with {@code reason} replaced and every other component kept. */
    public Seal withReason(String value) {
        return new Seal(enabled, layouts, certify, timestamp, value, location, visible, postedAnswers);
    }

    /** A copy with {@code location} replaced and every other component kept. */
    public Seal withLocation(String value) {
        return new Seal(enabled, layouts, certify, timestamp, reason, value, visible, postedAnswers);
    }

    /** A copy with {@code visible} replaced and every other component kept. */
    public Seal withVisible(Boolean value) {
        return new Seal(enabled, layouts, certify, timestamp, reason, location, value, postedAnswers);
    }

    /** A copy with {@code postedAnswers} replaced and every other component kept. */
    public Seal withPostedAnswers(boolean value) {
        return new Seal(enabled, layouts, certify, timestamp, reason, location, visible, value);
    }

        public Seal {
            // The certification word is checked when the settings are built: a typo never seals weaker than asked.
            if (certify != null) {
                SealPreset.Certify.parse(certify);
            }
            layouts = layouts == null ? List.of() : List.copyOf(layouts);
        }

        public static Seal defaults() {
            return new Seal(false, List.of(), "noChanges", true, null, null, null, false);
        }
    }

    /**
     * The default font pack.
     *
     * @throws IllegalArgumentException for a word that names no pack (the start fails, naming the property)
     */
    public PdfFonts.Pack fontPack() {
        return fontPackOf(fonts);
    }

    private static PdfFonts.Pack fontPackOf(String fonts) {
        PdfFonts.Pack pack = PdfFonts.Pack.parse(fonts);
        if (pack == null) {
            throw new DatumConfigurationException("datum.pdf.fonts", "datum.pdf.fonts is default, standard or all, not \"" + fonts + "\".");
        }
        return pack;
    }

    /**
     * The seal preset.
     *
     * @throws IllegalArgumentException for a certify word that names no level (the start fails rather than seal
     *     weaker than asked)
     */
    public SealPreset sealPreset() {
        return new SealPreset(seal.enabled(), seal.layouts(), SealPreset.Certify.parse(seal.certify()), seal.timestamp(), blank(seal.reason()),
            blank(seal.location()), seal.visible());
    }

    /** Certificates from an optional PEM resource, the property named when it cannot be read or holds none. */
    public static List<X509Certificate> certificates(String property, ResourceHandle resource) {
        if (resource == null) {
            return List.of();
        }
        try (InputStream in = resource.open()) {
            List<X509Certificate> found;
            try {
                found = PemCertificates.read(new String(in.readAllBytes(), StandardCharsets.US_ASCII));
            } catch (IllegalArgumentException damaged) {
                // A damaged block stops the start, naming the property (the one PEM reader does not skip it).
                throw new IllegalArgumentException(property + " cannot be read: " + damaged.getMessage(), damaged);
            }
            if (found.isEmpty()) {
                throw new IllegalArgumentException(property + " holds no certificate.");
            }
            return found;
        } catch (IOException e) {
            throw new IllegalArgumentException(property + " cannot be read: " + e.getMessage(), e);
        } catch (UncheckedIOException e) {
            throw new IllegalArgumentException(property + " cannot be read: " + e.getMessage(), e);
        }
    }

    private static String blank(String text) {
        return text == null || text.isBlank() ? null : text;
    }
}
