package com.argusvane.datum.timestamp;

import com.argusvane.datum.core.canonical.Jcs;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Objects;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * The receipt statement a signed submission's timestamp is taken over:
 * {@code {digest, form, received, reference, serial, signature}} in RFC 8785
 * (JCS, {@link Jcs} from datum-core). The token's imprint is the SHA-256 of the statement's UTF-8 bytes, so
 * {@code openssl ts -verify -data statement.json} checks it with no Datum code.
 *
 * @param form the form's id
 * @param reference the submission's reference
 * @param serial the submission's serial number
 * @param received when it was received (whole seconds are written)
 * @param digest the submission's digest
 * @param signature the passkey signature the stored document carries, as stored: one signature object, a list
 *     when there are more, {@code null} (JSON null) when there is none
 */
public record ReceiptStatement(String form, String reference, long serial, Instant received, String digest, JsonNode signature) {

    private static final DateTimeFormatter RECEIVED = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss'Z'").withZone(ZoneOffset.UTC);

    public ReceiptStatement {
        Objects.requireNonNull(form, "form");
        Objects.requireNonNull(reference, "reference");
        Objects.requireNonNull(received, "received");
        Objects.requireNonNull(digest, "digest");
    }

    /** The statement's canonical text (JCS). */
    public String canonical() {
        ObjectNode statement = JsonNodeFactory.instance.objectNode();
        statement.put("form", form);
        statement.put("reference", reference);
        statement.put("serial", serial);
        statement.put("received", RECEIVED.format(Instant.ofEpochSecond(received.getEpochSecond())));
        statement.put("digest", digest);
        statement.set("signature", signature == null ? JsonNodeFactory.instance.nullNode() : signature);
        return Jcs.canonicalize(statement);
    }

    /** The bytes timestamped: the canonical text in UTF-8. */
    public byte[] bytes() {
        return canonical().getBytes(StandardCharsets.UTF_8);
    }

    /** The token's imprint: SHA-256 of {@link #bytes()}. */
    public byte[] imprint() {
        return TimestampQuery.digest(TimestampQuery.SHA256, bytes());
    }

    /** A TimeStampReq over the statement: SHA-256, the certificate asked for, no nonce. */
    public byte[] query() {
        return TimestampQuery.forData(bytes());
    }
}
