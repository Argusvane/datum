package com.argusvane.datum.timestamp;

import com.argusvane.datum.core.observation.DatumObservation;
import com.argusvane.datum.core.observation.DatumObservationNames;
import com.argusvane.datum.core.observation.DatumObservations;
import java.io.IOException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.cert.CertificateEncodingException;
import java.security.cert.X509Certificate;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Date;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import org.bouncycastle.asn1.ASN1Boolean;
import org.bouncycastle.asn1.ASN1Encoding;
import org.bouncycastle.asn1.ASN1Integer;
import org.bouncycastle.asn1.ASN1ObjectIdentifier;
import org.bouncycastle.asn1.DERSet;
import org.bouncycastle.asn1.cms.Attribute;
import org.bouncycastle.asn1.cms.AttributeTable;
import org.bouncycastle.asn1.cms.CMSAttributes;
import org.bouncycastle.asn1.cms.Time;
import org.bouncycastle.asn1.nist.NISTObjectIdentifiers;
import org.bouncycastle.asn1.tsp.MessageImprint;
import org.bouncycastle.asn1.tsp.TimeStampReq;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.asn1.x509.AlgorithmIdentifier;
import org.bouncycastle.asn1.x509.GeneralName;
import org.bouncycastle.cert.X509CertificateHolder;
import org.bouncycastle.cert.jcajce.JcaCertStore;
import org.bouncycastle.cms.DefaultSignedAttributeTableGenerator;
import org.bouncycastle.cms.SignerInfoGenerator;
import org.bouncycastle.cms.jcajce.JcaSignerInfoGeneratorBuilder;
import org.bouncycastle.operator.DigestCalculator;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;
import org.bouncycastle.operator.jcajce.JcaDigestCalculatorProviderBuilder;
import org.bouncycastle.tsp.TimeStampRequest;
import org.bouncycastle.tsp.TimeStampToken;
import org.bouncycastle.tsp.TimeStampTokenGenerator;

/**
 * An RFC 3161 Time-Stamp Authority (with RFC 5816's ESSCertIDv2), its tokens generated with Bouncy Castle's {@code tsp}
 * package as it builds them (what binds a token is the PDF
 * kernel's parser, {@code certificateMatches} and {@code coversSignature}, and {@code openssl ts -verify}).
 *
 * <p>Answers a TimeStampReq with a TimeStampResp: a TimeStampToken, a CMS SignedData over a TSTInfo {version 1,
 * the policy, the request's message imprint as sent, a unique increasing serial number, genTime, accuracy, the
 * request's nonce by value (shortest form), the server's name (the certificate's subject as a directoryName)}, signed with the
 * key {@link TsaKeyMaterial} gives. Signed attributes: Bouncy Castle's default set (contentType, signingTime,
 * messageDigest, CMSAlgorithmProtection) with signingTime given as the token's genTime in whole seconds, so it comes
 * from the same {@link TsaTimeSource} and never from the raw system clock, and signingCertificateV2 (the certificate's
 * SHA-256, hashAlgorithm left out as the default, with its issuer and serial: the generator's
 * {@code isIssuerSerialIncluded}, RFC 5035, so the certificate is named by issuer and serial as well as by hash).
 * SignerInfo by IssuerAndSerialNumber, digest SHA-256, signature sha256WithRSAEncryption (NULL parameters) or
 * ecdsa-with-SHA256 (none). The certificate chain is in the token ([0]) only when the request asks for it (certReq),
 * leaf first as {@link TsaKey} gives it. A request's nonce is echoed by value, in its shortest form (RFC 3161 2.4.2: the
 * same value). Every refusal is a TimeStampResp with status rejection, a statusString and a PKIFailureInfo.
 *
 * <p>The checks run in this order, and no serial is taken for a refusal: the policy; the application's customizers;
 * the time source; the key, held on every token to the certificate rules (the private key is the certificate's, then
 * {@link TsaCertificateRules}: algorithm, validity at the server's clock, extended key usage), so no
 * {@link TsaKeyMaterial} can bring an unusable key past it; a key the material cannot give, one those checks refuse,
 * or a certificate Bouncy Castle's generator refuses or cannot carry byte for byte (below) is "no usable key"; then
 * the serial, taken before signing and never reused even when signing fails (RFC 3161 2.4.2: a serial is unique);
 * then the signature. Which requests reach it (the server turned on, the endpoint offered, clients, flood) is the
 * host's: the Spring endpoint, not this class.
 *
 * <p>The token is taken in Bouncy Castle's definite-length encoding, never re-encoded as DER: a DER pass would
 * rewrite a carried certificate that is valid BER but not strict DER (a BOOLEAN TRUE written 01, say), breaking its
 * signature and its ESSCertIDv2 hash. What Bouncy Castle cannot carry as given (a certificate whose own encoding it
 * would change, an issuer or subject Name it would re-sort as DER, so the kernel's signer match by those bytes would
 * fail) is refused up front as no usable key, and every token is read back before it leaves ({@link #checkIssued}): it
 * must echo the nonce, carry the certificates as given, and name its signer, its ESSCertIDv2 and its tsa by the
 * certificate's own bytes.
 *
 * <p>Thread-safe: between tokens it holds only the last key it found to be its certificate's, so the match is not
 * re-proven on every token while the material gives the same key and certificate objects.
 */
public final class TimestampAuthority implements Timestamper {

    private static final Logger LOG = LoggerFactory.getLogger(TimestampAuthority.class);

    /**
     * The policy tokens name unless the host sets its own: an object identifier under 2.25 (a UUID, needing no
     * registration), the Datum timestamp policy version 1 (tokens are issued for any digest a permitted client
     * sends, against the server's clock, with the stated accuracy; the server sees no document and vouches for
     * nothing but the time it saw the digest).
     */
    public static final String DEFAULT_POLICY = "2.25.212781426679957384705247099190076402205";

    /** The accuracy stated unless the host sets its own. */
    public static final Duration DEFAULT_ACCURACY = Duration.ofSeconds(1);

    /** The largest accuracy stated: a minute (a looser accuracy says little about when the digest was seen). */
    public static final Duration MAX_ACCURACY = Duration.ofSeconds(60);

    private final TsaKeyMaterial keys;
    private final String policy;
    private final long accuracyMillis;
    private final TsaTimeSource time;
    private final TsaSerialAllocator serials;
    /** The policies a request may ask for: the issuing one and any the host adds ({@code datum.tsa.accepted-policies}). */
    private final Set<String> acceptedPolicies;
    /** The application's per-request policy, in the framework's order. */
    private final List<TimestampRequestCustomizer> customizers;
    /** Where each token asked of it is reported ({@value DatumObservationNames#TSA_ISSUE}). */
    private final DatumObservations observations;

    /** The key and certificate last found to belong together (compared by identity), or {@code null}. */
    private volatile Matched matched;

    private record Matched(PrivateKey key, X509Certificate leaf) {
    }

    /**
     * The common case: an authority on the server's clock (always available) that accepts its issuing policy only, runs no
     * customizer and reports nothing.
     *
     * @param clock the server's clock (see {@link TsaTimeSource} for a source that can refuse)
     * @throws IllegalArgumentException when the policy is not an object identifier the server can write and read
     */
    public TimestampAuthority(TsaKeyMaterial keys, String policy, Duration accuracy, Clock clock, TsaSerialAllocator serials) {
        this(keys, policy, accuracy, TsaTimeSource.of(Objects.requireNonNull(clock, "clock")), serials, List.of(), List.of(),
            DatumObservations.none());
    }

    /**
     * @param keys where the signing key comes from, asked on every token
     * @param policy the policy the tokens name, dotted ({@link #DEFAULT_POLICY} when {@code null})
     * @param accuracy the accuracy stated, whole milliseconds, clamped to 0 to {@link #MAX_ACCURACY}; zero states
     *     none; under a second, genTime carries milliseconds ({@link #DEFAULT_ACCURACY} when {@code null})
     * @param time where "now" comes from; when it is unavailable no token is issued: the request is refused with
     *     RFC 3161's {@code timeNotAvailable} (503), before a key is loaded or a serial taken
     * @param serials takes each token's serial number before it is signed
     * @param acceptedPolicies further policies a request may ask for with {@code reqPolicy} (dotted); a token then names the
     *     policy asked for, as RFC 3161 has it. The issuing policy is always accepted; any other is refused with
     *     unacceptedPolicy. Empty accepts the issuing policy only
     * @param customizers the application's per-request policy, run in this order before any token is signed;
     *     empty for none
     * @param observations where each token asked of the authority is reported, its channel and its outcome
     *     ({@code granted} or the refusal's failure name) as a {@value DatumObservationNames#TSA_ISSUE} observation: the endpoint's requests under the HTTP request's trace, the host's own seals and receipts under the PDF
     *     operation that asked; {@link DatumObservations#none()} for none
     * @throws IllegalArgumentException when a policy is not an object identifier the server can write and read
     */
    public TimestampAuthority(TsaKeyMaterial keys, String policy, Duration accuracy, TsaTimeSource time, TsaSerialAllocator serials,
                              List<String> acceptedPolicies, List<TimestampRequestCustomizer> customizers, DatumObservations observations) {
        this.observations = Objects.requireNonNull(observations, "observations");
        this.customizers = List.copyOf(Objects.requireNonNull(customizers, "customizers"));
        this.keys = Objects.requireNonNull(keys, "keys");
        this.time = Objects.requireNonNull(time, "time");
        this.serials = Objects.requireNonNull(serials, "serials");
        String chosen = policy == null ? DEFAULT_POLICY : policy.trim();
        if (!Der.validOid(chosen)) {
            throw new IllegalArgumentException("The timestamp policy " + chosen + " is not an object identifier.");
        }
        this.policy = chosen;
        Set<String> accepted = new LinkedHashSet<>();
        accepted.add(chosen);
        for (String extra : acceptedPolicies == null ? List.<String>of() : acceptedPolicies) {
            String clean = extra == null ? "" : extra.trim();
            if (clean.isEmpty()) {
                continue;
            }
            if (!Der.validOid(clean)) {
                throw new IllegalArgumentException("The accepted timestamp policy " + clean + " (datum.tsa.accepted-policies) is not an object identifier.");
            }
            accepted.add(clean);
        }
        this.acceptedPolicies = Collections.unmodifiableSet(accepted);
        long millis = (accuracy == null ? DEFAULT_ACCURACY : accuracy).toMillis();
        this.accuracyMillis = Math.max(0, Math.min(MAX_ACCURACY.toMillis(), millis));
    }

    /** The policy the tokens name, dotted, when a request asks for none. */
    public String policy() {
        return policy;
    }

    /** The policies a request may ask for, the issuing one first. */
    public Set<String> acceptedPolicies() {
        return acceptedPolicies;
    }

    /** The accuracy the tokens state (zero: none). */
    public Duration accuracy() {
        return Duration.ofMillis(accuracyMillis);
    }

    /**
     * Answers a TimeStampReq from an endpoint: never throws for a refused request.
     *
     * @param query the request body, DER
     * @param client the client that asked ({@link TsaClient#id()}), or {@code null} for an open request
     * @return the HTTP status (200; 400 when the request is at fault, 503 when the server is), the TimeStampResp
     *     and, when a token was issued, the issue
     */
    public TimestampReply respond(byte[] query, String client) {
        try {
            TimestampResponse issued = observed("http", () -> issueUnobserved(TimestampQuery.parse(query), client, "http"));
            return new TimestampReply(200, issued.response(), issued, null);
        } catch (TimestampRefusedException refused) {
            return new TimestampReply(refused.refusal().httpStatus(), refused.refusal().toResponse(), null, refused.refusal());
        }
    }

    /**
     * A timestamp over data, for the host's own use (sealing a PDF, a receipt): a SHA-256 imprint, the
     * certificate asked for, no nonce.
     *
     * @return a granted TimeStampResp, DER
     * @throws TimestampRefusedException when no token can be issued
     */
    @Override
    public byte[] stamp(byte[] data, String channel) {
        Objects.requireNonNull(channel, "channel");
        return observed(channel, () -> issueUnobserved(TimestampQuery.parse(TimestampQuery.forData(data)), null, channel)).response();
    }

    /** Issues a token for an open request over HTTP. */
    public TimestampResponse issue(TimestampQuery query) {
        return issue(query, null, "http");
    }

    /**
     * Issues a token.
     *
     * @param query the request
     * @param client the client, or {@code null}
     * @param channel who asked: {@code http}, {@code sealing}, {@code receipt} and so on (for the log)
     * @throws TimestampRefusedException when it is refused: another policy (unacceptedPolicy), an application's
     *     {@link TimestampRequestCustomizer} (its own bit, badRequest for a hook refusal, systemFailure for a failure), the
     *     time source unavailable (timeNotAvailable, 503), no usable key, no serial, no signature (systemFailure)
     */
    public TimestampResponse issue(TimestampQuery query, String client, String channel) {
        Objects.requireNonNull(channel, "channel");
        return observed(channel, () -> issueUnobserved(query, client, channel));
    }

    /**
     * One token asked of the authority, observed: {@value DatumObservationNames#TSA_ISSUE} with the channel,
     * and {@code granted} or the refusal's failure name ({@code unacceptedPolicy}, {@code timeNotAvailable},
     * {@code systemFailure}, ...) as the outcome; the parse of the request is inside it, so a malformed one is observed too.
     */
    private TimestampResponse observed(String channel, java.util.function.Supplier<TimestampResponse> work) {
        DatumObservation observation = observations.start(DatumObservationNames.TSA_ISSUE, "datum tsa issue",
            DatumObservationNames.CHANNEL, channel);
        try {
            TimestampResponse issued = work.get();
            observation.lowCardinality(DatumObservationNames.OUTCOME, "granted");
            return issued;
        } catch (TimestampRefusedException refused) {
            observation.lowCardinality(DatumObservationNames.OUTCOME, refused.refusal().failName()).error(refused);
            throw refused;
        } catch (RuntimeException | Error e) {
            observation.lowCardinality(DatumObservationNames.OUTCOME, DatumObservations.outcomeOf(e)).error(e);
            throw e;
        } finally {
            observation.close();
        }
    }

    private TimestampResponse issueUnobserved(TimestampQuery query, String client, String channel) {
        Objects.requireNonNull(query, "query");
        Objects.requireNonNull(channel, "channel");
        if (query.policy() != null && !acceptedPolicies.contains(query.policy())) {
            throw new TimestampRefusedException(TimestampRefusal.FAIL_UNACCEPTED_POLICY,
                acceptedPolicies.size() == 1 ? String.format("This timestamp server issues tokens under policy %s only.", policy)
                    : String.format("This timestamp server issues tokens under the policies %s only.", String.join(", ", acceptedPolicies)));
        }
        // The application's per-request policy, before anything is loaded or spent: it may refuse, choose the
        // policy (only the one asked for when the request names one) and the accuracy within the bounds.
        TimestampRequestDraft draft = customized(query, client, channel);
        // The token names the policy asked for (RFC 3161), which the generator takes from the request, else the one the
        // customizers chose (the issuing one without them); the log and the issue say the same.
        String issuedPolicy = query.policy() != null ? query.policy() : draft.policy();
        long statedMillis = draft.accuracy().toMillis();
        Instant now = now();
        TsaKey key;
        TsaCertificate certificate;
        try {
            key = keys.load();
            if (key == null) {
                throw new TsaKeyException("The site has no timestamp server certificate.");
            }
            // On every token, whatever the material, in this order: the key is the certificate's, then the certificate
            // rules at the server's clock.
            if (!belongTogether(key)) {
                throw new TsaKeyException("No certificate given is the private key’s: the key and the certificate do not match.");
            }
            TsaCertificateRules.problem(key.leaf(), now).ifPresent(problem -> {
                throw new TsaKeyException(problem);
            });
            // Read by the reader the token's names are taken from (issuer, subject and serial as bytes), so a
            // certificate it cannot read is no usable key.
            certificate = new TsaCertificate(key.leaf().getEncoded());
            carriedAsGiven(key, certificate);
        } catch (RuntimeException | CertificateEncodingException | IOException e) {
            LOG.error("The timestamp server cannot issue tokens: {}", e.getMessage());
            throw new TimestampRefusedException(TimestampRefusal.FAIL_SYSTEM_FAILURE, "The timestamp server has no usable key.");
        }

        long seconds = now.getEpochSecond();
        Integer milliseconds = statedMillis > 0 && statedMillis < 1000 ? now.getNano() / 1_000_000 : null;
        byte[] genTime = Der.generalizedTime(seconds, milliseconds);
        String genTimeText = new String(Der.contents(genTime, Der.readAll(genTime)), StandardCharsets.US_ASCII);
        Date genDate = new Date(seconds * 1000 + (milliseconds == null ? 0 : milliseconds));

        TimeStampTokenGenerator generator;
        try {
            generator = generator(key, certificate, seconds, milliseconds != null, issuedPolicy, statedMillis);
        } catch (Exception e) {
            LOG.error("The timestamp server cannot issue tokens: {}", e.getMessage());
            throw new TimestampRefusedException(TimestampRefusal.FAIL_SYSTEM_FAILURE, "The timestamp server has no usable key.");
        }

        String fingerprint = key.fingerprint();
        long serial;
        try {
            serial = serials.allocate(new TsaLogEntry(genTimeText.length() > 32 ? genTimeText.substring(0, 32) : genTimeText,
                query.algorithm(), HexFormat.of().formatHex(query.hash()), issuedPolicy, fingerprint, client, channel));
            if (serial < 1) {
                throw new IllegalStateException("the allocator gave serial " + serial);
            }
        } catch (RuntimeException e) {
            LOG.error("The timestamp server could not take a serial number: {}", e.getMessage());
            throw new TimestampRefusedException(TimestampRefusal.FAIL_SYSTEM_FAILURE, "The timestamp server cannot issue tokens now.");
        }

        byte[] token;
        try {
            token = sign(generator, query, serial, genDate);
            checkIssued(token, query, key, certificate);
        } catch (Exception e) {
            LOG.atError().addKeyValue("serial", serial).log("The timestamp server could not sign token {}: {}", serial, e.getMessage());
            throw new TimestampRefusedException(TimestampRefusal.FAIL_SYSTEM_FAILURE, "The timestamp server cannot sign now.");
        }
        return new TimestampResponse(granted(token), token, serial, Instant.ofEpochSecond(seconds, milliseconds == null ? 0 : milliseconds * 1_000_000L),
            genTimeText, query.algorithm(), query.hash(), issuedPolicy, fingerprint, client, channel);
    }

    /**
     * The draft after the application's customizers, in their order. A refusal is the TSA's own (a
     * {@link TimestampRefusedException} as thrown, a hook refusal as {@code badRequest}); anything else a customizer throws
     * is {@code systemFailure}, its message in the log only.
     */
    private TimestampRequestDraft customized(TimestampQuery query, String client, String channel) {
        TimestampRequestDraft draft = new TimestampRequestDraft(query, client, channel, acceptedPolicies,
            query.policy() != null ? query.policy() : policy, Duration.ofMillis(accuracyMillis));
        for (TimestampRequestCustomizer customizer : customizers) {
            try {
                // The endpoint's tokens only unless the customizer opts in: a client policy must not
                // refuse the host's own seals and receipts, which carry no client.
                if (customizer.appliesTo(channel)) {
                    customizer.customize(draft);
                }
            } catch (TimestampRefusedException refused) {
                throw refused;
            } catch (com.argusvane.datum.core.hooks.HookRefusedException refused) {
                LOG.atInfo().addKeyValue("channel", channel).addKeyValue("code", refused.code())
                    .log("A timestamp request ({}) was refused by the application: {}", channel, refused.code());
                throw new TimestampRefusedException(TimestampRefusal.FAIL_BAD_REQUEST,
                    refused.getMessage() != null ? refused.getMessage() : "This timestamp server does not issue this token.");
            } catch (RuntimeException e) {
                LOG.atError().addKeyValue("channel", channel).log("A TimestampRequestCustomizer failed ({}): {}", channel, e.toString());
                throw new TimestampRefusedException(TimestampRefusal.FAIL_SYSTEM_FAILURE, "The timestamp server cannot issue tokens now.");
            }
        }
        return draft;
    }

    /**
     * The time source's reading, or the refusal RFC 3161 asks for when it has none. A source that throws or answers
     * nothing is unavailable too: its message goes to the log, never to the client.
     */
    private Instant now() {
        TsaTimeSource.Reading reading;
        try {
            reading = time.read();
        } catch (RuntimeException e) {
            LOG.error("The timestamp server's time source failed: {}", e.toString());
            reading = TsaTimeSource.Reading.unavailable("the time source failed");
        }
        if (reading instanceof TsaTimeSource.Available available) {
            return available.now();
        }
        String reason = reading instanceof TsaTimeSource.Unavailable unavailable ? unavailable.reason() : "no reading";
        LOG.warn("The timestamp server cannot issue tokens, its time source is not available: {}", reason);
        throw new TimestampRefusedException(TimestampRefusal.FAIL_TIME_NOT_AVAILABLE,
            "The timestamp server's time source is not available: " + reason + ".");
    }

    /** A granted TimeStampResp around a token (RFC 3161 2.4.2): {@code SEQ{SEQ{INTEGER 0}, token}}. */
    static byte[] granted(byte[] token) {
        return Der.sequence(Der.sequence(Der.integer(0)), token);
    }

    /** Whether the key is its certificate's: proven once per key and certificate pair the material gives. */
    private boolean belongTogether(TsaKey key) {
        Matched last = matched;
        if (last != null && last.key() == key.privateKey() && last.leaf() == key.leaf()) {
            return true;
        }
        if (!KeyChecks.matches(key.privateKey(), key.leaf())) {
            return false;
        }
        matched = new Matched(key.privateKey(), key.leaf());
        return true;
    }

    /**
     * Refuses what Bouncy Castle would not carry as given: a certificate of the chain whose own encoding it would
     * change (BER that is not strict DER), or an issuer or subject Name it would rewrite when it writes the
     * SignerInfo, the ESSCertIDv2 or the tsa name as DER: the kernel matches the signer by the certificate's own bytes,
     * and a re-encoded certificate's signature would no longer hold.
     */
    private static void carriedAsGiven(TsaKey key, TsaCertificate certificate) throws IOException, CertificateEncodingException {
        for (X509Certificate one : key.chain()) {
            byte[] raw = one.getEncoded();
            if (!Arrays.equals(raw, new X509CertificateHolder(raw).toASN1Structure().getEncoded(ASN1Encoding.DL))) {
                throw new TsaKeyException("The certificate " + one.getSubjectX500Principal().getName()
                    + " is not in DER: it would not be carried in tokens byte for byte.");
            }
        }
        if (!Arrays.equals(certificate.issuer(), X500Name.getInstance(certificate.issuer()).getEncoded(ASN1Encoding.DER))
            || !Arrays.equals(certificate.subject(), X500Name.getInstance(certificate.subject()).getEncoded(ASN1Encoding.DER))) {
            throw new TsaKeyException("The certificate's issuer or subject name is not in DER: tokens would not name it byte for byte.");
        }
    }

    private TimeStampTokenGenerator generator(TsaKey key, TsaCertificate certificate, long seconds, boolean milliseconds, String tokenPolicy,
                                              long statedMillis) throws Exception {
        String algorithm = KeyChecks.signatureAlgorithm(key.privateKey());
        if (algorithm == null) {
            throw new TsaKeyException("The key is " + key.privateKey().getAlgorithm() + ": tokens are signed with RSA or ECDSA keys.");
        }
        // Bouncy Castle's own attribute set, given the signing time so it is the token's time, not the system clock's.
        AttributeTable signingTime = new AttributeTable(new Attribute(CMSAttributes.signingTime, new DERSet(new Time(new Date(seconds * 1000)))));
        SignerInfoGenerator signer = new JcaSignerInfoGeneratorBuilder(new JcaDigestCalculatorProviderBuilder().build())
            .setSignedAttributeGenerator(new DefaultSignedAttributeTableGenerator(signingTime))
            .build(new JcaContentSignerBuilder(algorithm).build(key.privateKey()), key.leaf());
        DigestCalculator essCertIdDigest = new JcaDigestCalculatorProviderBuilder().build()
            .get(new AlgorithmIdentifier(NISTObjectIdentifiers.id_sha256));
        TimeStampTokenGenerator generator = new TimeStampTokenGenerator(signer, essCertIdDigest, new ASN1ObjectIdentifier(tokenPolicy), true);
        if (statedMillis > 0) {
            if (statedMillis >= 1000) {
                generator.setAccuracySeconds((int) (statedMillis / 1000));
            }
            if (statedMillis % 1000 > 0) {
                generator.setAccuracyMillis((int) (statedMillis % 1000));
            }
        }
        generator.setResolution(milliseconds ? TimeStampTokenGenerator.R_MILLISECONDS : TimeStampTokenGenerator.R_SECONDS);
        // The tsa [0] GeneralName: the directoryName [4] of the certificate's subject, from its bytes.
        generator.setTSA(new GeneralName(GeneralName.directoryName, X500Name.getInstance(certificate.subject())));
        // The chain as the key gives it, leaf first; Bouncy Castle keeps that order in its definite-length encoding.
        generator.addCertificates(new JcaCertStore(key.chain()));
        return generator;
    }

    private static byte[] sign(TimeStampTokenGenerator generator, TimestampQuery query, long serial, Date genTime) throws Exception {
        byte[] nonce = query.nonce();
        TimeStampReq request = new TimeStampReq(
            MessageImprint.getInstance(query.messageImprint()),
            query.policy() == null ? null : new ASN1ObjectIdentifier(query.policy()),
            // By value: a request's INTEGER need not be in its shortest form, the token's is (RFC 3161 2.4.2: the same value).
            nonce == null ? null : new ASN1Integer(nonceValue(nonce)),
            query.certReq() ? ASN1Boolean.TRUE : ASN1Boolean.FALSE,
            null);
        TimeStampToken token = generator.generate(new TimeStampRequest(request), BigInteger.valueOf(serial), genTime);
        // Definite-length, as Bouncy Castle wrote it: never re-encoded as DER (see the class comment).
        return token.getEncoded(ASN1Encoding.DL);
    }

    /** A nonce INTEGER's value (whole TLV; the reader took only a positive one). */
    private static BigInteger nonceValue(byte[] nonce) {
        return new BigInteger(Der.contents(nonce, Der.readAll(nonce)));
    }

    /**
     * Reads a token back before it leaves: it must echo the request's nonce by value; carry the certificates as given,
     * leaf first (only when asked for); name its signer by the certificate's issuer and serial bytes; carry an
     * ESSCertIDv2 of the certificate's SHA-256, its issuer and serial; and name the certificate's subject as its tsa.
     * These are what a verifier binds the token to (the kernel's {@code certificateMatches}, openssl's ESS check), so
     * a generator that rewrote any of them is a failure to sign, not a token.
     */
    static void checkIssued(byte[] token, TimestampQuery query, TsaKey key, TsaCertificate certificate) throws Exception {
        TimestampToken parsed = TimestampToken.parse(token);
        byte[] echoed = parsed.nonce();
        if (query.nonce() == null ? echoed != null : echoed == null || !nonceValue(query.nonce()).equals(nonceValue(echoed))) {
            throw new IllegalStateException("the token does not echo the nonce");
        }
        List<Der.Node> contentInfo = Der.children(token, Der.readAll(token));
        List<Der.Node> fields = Der.children(token, Der.children(token, contentInfo.get(1)).get(0));
        byte[] carried = null;
        Der.Node signerInfos = null;
        for (Der.Node field : fields.subList(3, fields.size())) {
            if (field.tag() == 0xa0) {
                carried = Der.contents(token, field);
            } else if (field.tag() == Der.SET) {
                signerInfos = field;
            }
        }
        if (query.certReq()) {
            List<byte[]> chain = new ArrayList<>();
            for (X509Certificate one : key.chain()) {
                chain.add(one.getEncoded());
            }
            if (carried == null || !Arrays.equals(carried, Der.concat(chain.toArray(byte[][]::new)))) {
                throw new IllegalStateException("the token does not carry the certificates as given");
            }
        } else if (carried != null) {
            throw new IllegalStateException("the token carries certificates no one asked for");
        }
        List<Der.Node> signer = Der.children(token, Der.children(token, signerInfos).get(0));
        if (!Arrays.equals(Der.raw(token, signer.get(1)), Der.sequence(certificate.issuer(), certificate.serial()))) {
            throw new IllegalStateException("the token does not name its signer by the certificate's issuer and serial");
        }
        byte[] essCertId = Der.sequence(Der.sequence(Der.sequence(
            Der.octetString(MessageDigest.getInstance("SHA-256").digest(key.leaf().getEncoded())),
            Der.sequence(Der.sequence(Der.explicit(4, certificate.issuer())), certificate.serial()))));
        boolean named = false;
        for (Der.Node attribute : Der.children(token, signer.get(3))) {
            List<Der.Node> parts = Der.children(token, attribute);
            if (Der.readOid(token, parts.get(0)).equals("1.2.840.113549.1.9.16.2.47")) {
                named = Arrays.equals(Der.contents(token, parts.get(1)), essCertId);
            }
        }
        if (!named) {
            throw new IllegalStateException("the token's ESSCertIDv2 is not the certificate's");
        }
        byte[] tstInfo = parsed.tstInfo();
        List<Der.Node> info = Der.children(tstInfo, Der.readAll(tstInfo));
        Der.Node last = info.get(info.size() - 1);
        if (!Arrays.equals(Der.raw(tstInfo, last), Der.explicit(0, Der.explicit(4, certificate.subject())))) {
            throw new IllegalStateException("the token's tsa name is not the certificate's subject");
        }
    }
}
