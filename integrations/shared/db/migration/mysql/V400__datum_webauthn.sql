-- Datum WebAuthn: passkeys, the digests each passkey's key has signed, and the claimed registration challenges
-- (tables datum_passkey, datum_passkey_use and the expiring challenge collection). Timestamps are
-- epoch milliseconds. Task 8B owns the V400 range of migration versions (forms V100, submissions V200,
-- timestamp V300), so Flyway never sees one version twice when several Datum jars are on the class path.
--
-- Both unique keys are here, over every row, revoked and removed ones included: credential_sha256
-- (one credential id, once) and public_key_sha256 (a key read off someone's signature must not come back
-- under a new credential id). datum_passkey_use outlives its passkeys on purpose (no foreign key): a key
-- registered again later still cannot sign a digest again. replaced_sign_count is the counter value the use's
-- counter move replaced, written in the claim's transaction, so a release can put back exactly that.
--
-- Widths follow what the ceremony accepts, so a valid registration never meets a column: transports are up to 8
-- words of 32 characters joined with commas (263), the owner is the principal's name (512, also the longest
-- that fits MySQL's index key together with form_id) and the public key up to 16 KiB (the repository refuses a
-- longer one on every database alike, PostgreSQL's BYTEA having no limit of its own).
CREATE TABLE datum_passkey (
    id                BIGINT NOT NULL AUTO_INCREMENT,
    owner             VARCHAR(512)  NOT NULL DEFAULT '',
    credential_id     VARCHAR(1400) NOT NULL,
    credential_sha256 CHAR(64)      NOT NULL,
    public_key_sha256 CHAR(64)      NOT NULL,
    label             VARCHAR(512)  NOT NULL DEFAULT '',
    form_id           VARCHAR(128)  NOT NULL DEFAULT '',
    public_key        VARBINARY(16384) NOT NULL,
    algorithm         INT           NOT NULL,
    transports        VARCHAR(512)  NOT NULL DEFAULT '',
    sign_count        BIGINT        NOT NULL DEFAULT 0,
    user_verified     BOOLEAN       NOT NULL DEFAULT FALSE,
    backup_eligible   BOOLEAN       NOT NULL DEFAULT FALSE,
    backed_up         BOOLEAN       NOT NULL DEFAULT FALSE,
    user_handle       VARCHAR(255)  NOT NULL DEFAULT '',
    origin            VARCHAR(16)   NOT NULL DEFAULT 'form',
    made_on           VARCHAR(128)  NOT NULL DEFAULT '',
    aaguid            VARCHAR(36)   NOT NULL DEFAULT '',
    attestation       VARCHAR(32)   NOT NULL DEFAULT '',
    rp_id             VARCHAR(255)  NOT NULL DEFAULT '',
    web_origin        VARCHAR(255)  NOT NULL DEFAULT '',
    browser           VARCHAR(128)  NOT NULL DEFAULT '',
    created           BIGINT        NOT NULL,
    last_used         BIGINT,
    revoked           BIGINT,
    revoked_by        VARCHAR(512),
    removed           BIGINT,
    PRIMARY KEY (id),
    CONSTRAINT datum_passkey_credential UNIQUE (credential_sha256),
    CONSTRAINT datum_passkey_public_key UNIQUE (public_key_sha256)
);
CREATE INDEX datum_passkey_owner ON datum_passkey (owner, form_id);

CREATE TABLE datum_passkey_use (
    id                  BIGINT NOT NULL AUTO_INCREMENT,
    key_sha256          CHAR(64)     NOT NULL,
    digest              CHAR(64)     NOT NULL,
    passkey_id          BIGINT       NOT NULL,
    submission          VARCHAR(255) NOT NULL DEFAULT '',
    sign_count          BIGINT       NOT NULL DEFAULT 0,
    replaced_sign_count BIGINT       NOT NULL DEFAULT 0,
    used_at             BIGINT       NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT datum_passkey_use_claim UNIQUE (key_sha256, digest)
);
CREATE INDEX datum_passkey_use_passkey ON datum_passkey_use (passkey_id);

CREATE TABLE datum_passkey_challenge (
    nonce   VARCHAR(64) NOT NULL,
    expires BIGINT      NOT NULL,
    PRIMARY KEY (nonce)
);
CREATE INDEX datum_passkey_challenge_expires ON datum_passkey_challenge (expires);
