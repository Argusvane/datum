package com.argusvane.datum.tck;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Map;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;

/**
 * The RFC 3161 timestamp server, open to anonymous clients (or with the client key in {@link HostTarget#headers()}):
 * a query is answered with a granted {@code TimeStampResp} over the very digest, bytes the server cannot read are a
 * rejection, the checks before the body come in their order (403 for a browser session cookie, 415 for another
 * type), and the certificates are public in PEM and DER. The openssl round trip stays in the Spring tsa-server example.
 */
public interface TsaContract extends HostContract {

    private static byte[] sha256(byte[] data) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(data);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private Reply stamp(byte[] query, Map<String, String> headers) {
        return http().send("POST", target().tsaPath(), "application/timestamp-query", query, HostTarget.Who.VISITOR, headers);
    }

    @Test
    @Order(1501)
    default void aQueryIsGrantedOverItsDigest() {
        byte[] data = new byte[48];
        new SecureRandom().nextBytes(data);
        byte[] digest = sha256(data);
        BigInteger nonce = new BigInteger(63, new SecureRandom());
        Reply reply = stamp(Der.timeStampRequest(digest, nonce), Map.of());
        assertThat(reply.status()).as(reply.toString()).isEqualTo(200);
        assertThat(reply.mediaType()).isEqualTo("application/timestamp-reply");
        assertThat(reply.header("Cache-Control")).hasValueSatisfying(value -> assertThat(value).contains("no-store"));
        assertThat(Der.pkiStatus(reply.body())).isIn(0, 1);
        // The token's TSTInfo carries the digest and the nonce as sent.
        assertThat(Der.contains(reply.body(), digest)).as("the token names the digest").isTrue();
        assertThat(Der.contains(reply.body(), nonce.toByteArray())).as("the token carries the nonce").isTrue();
    }

    @Test
    @Order(1502)
    default void bytesTheServerCannotReadAreARejection() {
        Reply reply = stamp("not a TimeStampReq".getBytes(StandardCharsets.US_ASCII), Map.of());
        assertThat(reply.status()).as(reply.toString()).isEqualTo(400);
        assertThat(reply.mediaType()).isEqualTo("application/timestamp-reply");
        assertThat(Der.pkiStatus(reply.body())).isEqualTo(2);
    }

    @Test
    @Order(1503)
    default void aSessionCookieThenAnotherTypeAreRefusedBeforeTheBodyIsRead() {
        byte[] query = Der.timeStampRequest(sha256(new byte[] {1}), BigInteger.TEN);
        Reply cookie = stamp(query, Map.of("Cookie", "JSESSIONID=datum-tck"));
        assertThat(cookie.status()).as(cookie.toString()).isEqualTo(403);
        // The default session cookie rule is any cookie ("*"), not a list of known session names.
        Reply anyCookie = stamp(query, Map.of("Cookie", "a=b"));
        assertThat(anyCookie.status()).as(anyCookie.toString()).isEqualTo(403);
        Reply wrongType = http().send("POST", target().tsaPath(), "application/octet-stream", query, HostTarget.Who.VISITOR, Map.of());
        assertThat(wrongType.status()).as(wrongType.toString()).isEqualTo(415);
    }

    @Test
    @Order(1504)
    default void theCertificatesArePublic() {
        Reply all = http().get(target().tsaPath() + "/certificates");
        assertThat(all.status()).as(all.toString()).isEqualTo(200);
        assertThat(all.text()).contains("-----BEGIN CERTIFICATE-----");
        Reply chain = http().get(target().tsaPath() + "/certificate");
        assertThat(chain.status()).as(chain.toString()).isEqualTo(200);
        assertThat(chain.text()).contains("-----BEGIN CERTIFICATE-----");
        Reply der = http().get(target().tsaPath() + "/certificate?format=der");
        assertThat(der.status()).as(der.toString()).isEqualTo(200);
        assertThat(der.mediaType()).isEqualTo("application/pkix-cert");
        assertThat(Der.parse(der.body()).tag()).isEqualTo(0x30);
    }
}
