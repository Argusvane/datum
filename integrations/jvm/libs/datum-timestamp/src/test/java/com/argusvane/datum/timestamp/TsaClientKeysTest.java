package com.argusvane.datum.timestamp;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import org.junit.jupiter.api.Test;

/** Client keys in Datum's format: made, hashed, hinted and read back. */
class TsaClientKeysTest {

    @Test
    void aKeyIsThePrefixAnd32RandomBytesStoredAsItsSha256() {
        String key = TsaClientKeys.generate();
        assertThat(key).matches("^dtsa_[A-Za-z0-9_-]{43}$");
        assertThat(TsaClientKeys.generate()).isNotEqualTo(key);
        assertThat(TsaClientKeys.hash(key)).matches("^[0-9a-f]{64}$").doesNotContain(key);
        assertThat(TsaClientKeys.hash("dtsa_abc")).isEqualTo(sha256Hex("dtsa_abc"));
        assertThat(TsaClientKeys.hint(key)).hasSize(11).startsWith("dtsa_");
        assertThat(TsaClientKeys.matches(key, TsaClientKeys.hash(key))).isTrue();
        assertThat(TsaClientKeys.matches(key, TsaClientKeys.hash(key).toUpperCase())).isTrue();
        assertThat(TsaClientKeys.matches("dtsa_wrong", TsaClientKeys.hash(key))).isFalse();
        assertThat(TsaClientKeys.matches(null, TsaClientKeys.hash(key))).isFalse();
    }

    @Test
    void aRequestCarriesTheKeyAsABearerTokenOrABasicPassword() {
        assertThat(TsaClientKeys.keyOf("Bearer dtsa_abc")).isEqualTo("dtsa_abc");
        assertThat(TsaClientKeys.keyOf("bearer   dtsa_abc  ")).isEqualTo("dtsa_abc");
        assertThat(TsaClientKeys.keyOf("Basic " + basic("anyone:dtsa_abc"))).isEqualTo("dtsa_abc");
        assertThat(TsaClientKeys.keyOf("Basic " + basic("anyone:pass:with:colons"))).isEqualTo("pass:with:colons");
        assertThat(TsaClientKeys.keyOf("Basic " + basic("no-colon"))).isNull();
        assertThat(TsaClientKeys.keyOf("Basic " + basic("user:"))).isNull();
        assertThat(TsaClientKeys.keyOf("Basic !!!")).isNull();
        assertThat(TsaClientKeys.keyOf("Bearer")).isNull();
        assertThat(TsaClientKeys.keyOf("")).isNull();
        assertThat(TsaClientKeys.keyOf(null)).isNull();
        // An empty Authorization header carries no credentials.
        assertThat(TsaClientKeys.hasCredentials("")).isFalse();
        assertThat(TsaClientKeys.hasCredentials("  ")).isFalse();
        assertThat(TsaClientKeys.hasCredentials("Bearer x")).isTrue();
    }

    private static String basic(String text) {
        return Base64.getEncoder().encodeToString(text.getBytes(StandardCharsets.UTF_8));
    }

    private static String sha256Hex(String text) {
        try {
            return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
