package com.argusvane.datum.webauthn;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * A passkey registered on this site: a row of the shared SQL's V400 {@code datum_passkey} table.
 *
 * <p>A passkey a stored submission names is never deleted: it is revoked and its label cleared, and its key,
 * credential id and counter stay, so what it signed can be checked again ({@link #removed()}).
 *
 * @param id the repository's id; null before {@link PasskeyRepository#create}
 * @param owner who owns it: a principal's id, "" for none (a visitor's or an invited passkey)
 * @param credentialId the credential id, base64url as the browser names it
 * @param label its name ("" once removed); may be an answer (a person's name), so never logged
 * @param formId the form it signs alone ("" for any form: site-wide passkeys)
 * @param publicKey its public key, SPKI DER (from the authenticator data, never one the page named); copied
 * @param algorithm its COSE algorithm ({@link CoseKey#ES256} or {@link CoseKey#RS256}): what every assertion is
 *     checked under
 * @param transports what the browser reported (at most 8 words of [a-z-])
 * @param signCount the counter last seen
 * @param userVerified whether the registration reported user verification
 * @param backupEligible the BE flag at registration
 * @param backedUp the BS flag at registration
 * @param userHandle the user handle handed out (base64url), "" for none
 * @param origin how it was made: form, account or invitation
 * @param madeOn the form it was made through ("" ahead of time)
 * @param aaguid the authenticator's AAGUID (8-4-4-4-12; all zeros under attestation "none")
 * @param attestation the attestation format ("none"), "" when the browser sent no attestation object
 * @param rpId the passkey domain it was made for
 * @param webOrigin the origin the registration's client data named
 * @param browser a short summary of the registering browser (never the User-Agent itself), or ""
 * @param created when it was registered
 * @param lastUsed when it last signed something stored, or null
 * @param revoked when it was revoked, or null
 * @param revokedBy who revoked it ("" the system), or null
 * @param removed when its owner removed it while a submission it signed was kept, or null
 */
public record PasskeyRecord(@Nullable Long id, String owner, String credentialId, String label, String formId, byte[] publicKey, int algorithm,
                            List<String> transports, long signCount, boolean userVerified, boolean backupEligible, boolean backedUp,
                            String userHandle, String origin, String madeOn, String aaguid, String attestation, String rpId, String webOrigin,
                            String browser, Instant created, @Nullable Instant lastUsed, @Nullable Instant revoked, @Nullable String revokedBy,
                            @Nullable Instant removed) {

    public PasskeyRecord {
        owner = owner == null ? "" : owner;
        Objects.requireNonNull(credentialId, "credentialId");
        label = label == null ? "" : label;
        formId = formId == null ? "" : formId;
        publicKey = Objects.requireNonNull(publicKey, "publicKey").clone();
        transports = transports == null ? List.of() : List.copyOf(transports);
        userHandle = userHandle == null ? "" : userHandle;
        origin = origin == null ? "form" : origin;
        madeOn = madeOn == null ? "" : madeOn;
        aaguid = aaguid == null ? "" : aaguid;
        attestation = attestation == null ? "" : attestation;
        rpId = rpId == null ? "" : rpId;
        webOrigin = webOrigin == null ? "" : webOrigin;
        browser = browser == null ? "" : browser;
        Objects.requireNonNull(created, "created");
    }

    @Override
    public byte[] publicKey() {
        return publicKey.clone();
    }

    /** Whether it was revoked: it signs nothing new here. */
    public boolean isRevoked() {
        return revoked != null;
    }

    /** Whether its owner removed it (kept, revoked and nameless, for what it signed). */
    public boolean isRemoved() {
        return removed != null;
    }

    /** SHA-256 (hex) of its SPKI: the key the replay guard files signed digests under. */
    public String publicKeyHash() {
        return HexFormat.of().formatHex(WebAuthnVerifier.sha256(publicKey));
    }

    /** SHA-256 (hex) of its credential id: what a repository looks it up by, whatever the collation. */
    public String credentialSha256() {
        return HexFormat.of().formatHex(WebAuthnVerifier.sha256(credentialId.getBytes(StandardCharsets.UTF_8)));
    }

    public static Builder builder() {
        return new Builder();
    }

    public Builder toBuilder() {
        Builder builder = new Builder();
        builder.id = id;
        builder.owner = owner;
        builder.credentialId = credentialId;
        builder.label = label;
        builder.formId = formId;
        builder.publicKey = publicKey;
        builder.algorithm = algorithm;
        builder.transports = transports;
        builder.signCount = signCount;
        builder.userVerified = userVerified;
        builder.backupEligible = backupEligible;
        builder.backedUp = backedUp;
        builder.userHandle = userHandle;
        builder.origin = origin;
        builder.madeOn = madeOn;
        builder.aaguid = aaguid;
        builder.attestation = attestation;
        builder.rpId = rpId;
        builder.webOrigin = webOrigin;
        builder.browser = browser;
        builder.created = created;
        builder.lastUsed = lastUsed;
        builder.revoked = revoked;
        builder.revokedBy = revokedBy;
        builder.removed = removed;
        return builder;
    }

    /** A builder; every field but credentialId, publicKey and created has a default. */
    public static final class Builder {
        private Long id;
        private String owner = "";
        private String credentialId;
        private String label = "";
        private String formId = "";
        private byte[] publicKey;
        private int algorithm = CoseKey.ES256;
        private List<String> transports = List.of();
        private long signCount;
        private boolean userVerified;
        private boolean backupEligible;
        private boolean backedUp;
        private String userHandle = "";
        private String origin = "form";
        private String madeOn = "";
        private String aaguid = "";
        private String attestation = "";
        private String rpId = "";
        private String webOrigin = "";
        private String browser = "";
        private Instant created;
        private Instant lastUsed;
        private Instant revoked;
        private String revokedBy;
        private Instant removed;

        private Builder() {
        }

        public Builder id(Long value) { id = value; return this; }
        public Builder owner(String value) { owner = value; return this; }
        public Builder credentialId(String value) { credentialId = value; return this; }
        public Builder label(String value) { label = value; return this; }
        public Builder formId(String value) { formId = value; return this; }
        public Builder publicKey(byte[] value) { publicKey = value; return this; }
        public Builder algorithm(int value) { algorithm = value; return this; }
        public Builder transports(List<String> value) { transports = value; return this; }
        public Builder signCount(long value) { signCount = value; return this; }
        public Builder userVerified(boolean value) { userVerified = value; return this; }
        public Builder backupEligible(boolean value) { backupEligible = value; return this; }
        public Builder backedUp(boolean value) { backedUp = value; return this; }
        public Builder userHandle(String value) { userHandle = value; return this; }
        public Builder origin(String value) { origin = value; return this; }
        public Builder madeOn(String value) { madeOn = value; return this; }
        public Builder aaguid(String value) { aaguid = value; return this; }
        public Builder attestation(String value) { attestation = value; return this; }
        public Builder rpId(String value) { rpId = value; return this; }
        public Builder webOrigin(String value) { webOrigin = value; return this; }
        public Builder browser(String value) { browser = value; return this; }
        public Builder created(Instant value) { created = value; return this; }
        public Builder lastUsed(Instant value) { lastUsed = value; return this; }
        public Builder revoked(Instant value) { revoked = value; return this; }
        public Builder revokedBy(String value) { revokedBy = value; return this; }
        public Builder removed(Instant value) { removed = value; return this; }

        public PasskeyRecord build() {
            return new PasskeyRecord(id, owner, credentialId, label, formId, publicKey, algorithm, transports, signCount, userVerified,
                backupEligible, backedUp, userHandle, origin, madeOn, aaguid, attestation, rpId, webOrigin, browser, created, lastUsed,
                revoked, revokedBy, removed);
        }
    }
}
