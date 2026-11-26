package com.argusvane.datum.webauthn;

import static org.assertj.core.api.Assertions.assertThat;

import com.webauthn4j.converter.util.ObjectConverter;
import com.webauthn4j.data.attestation.authenticator.COSEKey;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.math.BigInteger;
import java.security.KeyPairGenerator;
import java.security.interfaces.ECPublicKey;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.RSAKeyGenParameterSpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The stored keys do not move: the SPKI of a credential's COSE key as webauthn4j builds it equals, byte for
 * byte, the DER an independent reference encoder below writes, for hundreds of generated keys and for a recorded set of vectors (fixed, so the leading-zero cases never depend on chance). The
 * stored SPKI and its hash drive the duplicate-key refusal (409 passkey.exists), so a change of encoding would let a key
 * read off a signature come back under a new credential id.
 */
class SpkiContinuityTest {

    private static final ObjectConverter OBJECTS = new ObjectConverter();

    @Test
    void es256KeysEncodeAsTheReference() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        for (int i = 0; i < 400; i++) {
            ECPublicKey key = (ECPublicKey) generator.generateKeyPair().getPublic();
            byte[] x = pad(unsigned(key.getW().getAffineX()), 32);
            byte[] y = pad(unsigned(key.getW().getAffineY()), 32);
            Map<Object, Object> cose = new LinkedHashMap<>();
            cose.put(1L, 2L);
            cose.put(3L, (long) CoseKey.ES256);
            cose.put(-1L, 1L);
            cose.put(-2L, new TestCbor.Bytes(x));
            cose.put(-3L, new TestCbor.Bytes(y));
            CoseKey.Spki spki = CoseKey.fromCose(read(cose));
            assertThat(spki.spki()).isEqualTo(referenceEs256(x, y)).isEqualTo(key.getEncoded());
            assertThat(spki.algorithm()).isEqualTo(CoseKey.ES256);
        }
        // A coordinate with a leading zero byte comes up about once in 128 keys, so a run of generated keys may or may not
        // meet one: asserting that it did made this test red by chance about 4 in 100 runs. The recorded vectors below
        // always carry the short-coordinate cases.
    }

    @Test
    void recordedEs256VectorsEncodeAsRecorded() throws Exception {
        int shortCases = 0;
        for (String[] vector : vectors("ES")) {
            byte[] x = HexFormat.of().parseHex(vector[2]);
            byte[] y = HexFormat.of().parseHex(vector[3]);
            Map<Object, Object> cose = new LinkedHashMap<>();
            cose.put(1L, 2L);
            cose.put(3L, (long) CoseKey.ES256);
            cose.put(-1L, 1L);
            cose.put(-2L, new TestCbor.Bytes(x));
            cose.put(-3L, new TestCbor.Bytes(y));
            byte[] expected = HexFormat.of().parseHex(vector[4]);
            assertThat(CoseKey.fromCose(read(cose)).spki()).as(vector[1]).isEqualTo(expected).isEqualTo(referenceEs256(x, y));
            if (x[0] == 0 || y[0] == 0) {
                shortCases++;
            }
        }
        assertThat(shortCases).as("the recorded set keeps the leading-zero coordinates").isGreaterThanOrEqualTo(3);
    }

    @Test
    void recordedRs256VectorsEncodeAsRecorded() throws Exception {
        for (String[] vector : vectors("RS")) {
            byte[] n = HexFormat.of().parseHex(vector[2]);
            byte[] e = HexFormat.of().parseHex(vector[3]);
            byte[] expected = HexFormat.of().parseHex(vector[4]);
            for (byte[] written : new byte[][] {n, concat(new byte[] {0}, n)}) {
                Map<Object, Object> cose = new LinkedHashMap<>();
                cose.put(1L, 3L);
                cose.put(3L, (long) CoseKey.RS256);
                cose.put(-1L, new TestCbor.Bytes(written));
                cose.put(-2L, new TestCbor.Bytes(e));
                assertThat(CoseKey.fromCose(read(cose)).spki()).as(vector[1]).isEqualTo(expected).isEqualTo(referenceRs256(written, e));
            }
        }
    }

    private static List<String[]> vectors(String kind) throws Exception {
        try (InputStream in = SpkiContinuityTest.class.getResourceAsStream("spki-vectors.txt")) {
            List<String[]> out = new ArrayList<>();
            for (String line : new String(in.readAllBytes(), StandardCharsets.UTF_8).split("\n")) {
                if (!line.isBlank() && !line.startsWith("#") && line.startsWith(kind + "|")) {
                    out.add(line.trim().split("\\|"));
                }
            }
            assertThat(out).isNotEmpty();
            return out;
        }
    }

    @Test
    void rs256KeysEncodeAsTheReference() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        BigInteger[] exponents = {RSAKeyGenParameterSpec.F4, RSAKeyGenParameterSpec.F0, BigInteger.valueOf(65539), BigInteger.valueOf(17)};
        for (int i = 0; i < 40; i++) {
            BigInteger exponent = exponents[i % exponents.length];
            generator.initialize(new RSAKeyGenParameterSpec(i % 5 == 4 ? 3072 : 2048, exponent));
            RSAPublicKey key = (RSAPublicKey) generator.generateKeyPair().getPublic();
            byte[] n = unsigned(key.getModulus());
            byte[] e = unsigned(key.getPublicExponent());
            // Some authenticators write the modulus with a leading zero byte: the same key.
            byte[] written = i % 3 == 0 ? concat(new byte[] {0}, n) : n;
            Map<Object, Object> cose = new LinkedHashMap<>();
            cose.put(1L, 3L);
            cose.put(3L, (long) CoseKey.RS256);
            cose.put(-1L, new TestCbor.Bytes(written));
            cose.put(-2L, new TestCbor.Bytes(e));
            CoseKey.Spki spki = CoseKey.fromCose(read(cose));
            assertThat(spki.spki()).isEqualTo(referenceRs256(written, e)).isEqualTo(key.getEncoded());
            assertThat(spki.algorithm()).isEqualTo(CoseKey.RS256);
        }
    }

    private static COSEKey read(Map<Object, Object> cose) {
        return OBJECTS.getCborMapper().readValue(TestCbor.encode(cose), COSEKey.class);
    }

    // An independent reference encoder (fixed DER prefixes and a minimal DER writer): the oracle of the tests above.

    private static final byte[] P256_SPKI_PREFIX = HexFormat.of().parseHex("3059301306072a8648ce3d020106082a8648ce3d03010703420004");
    private static final byte[] RSA_ALGORITHM = HexFormat.of().parseHex("300d06092a864886f70d0101010500");

    private static byte[] referenceEs256(byte[] x, byte[] y) {
        return concat(P256_SPKI_PREFIX, x, y);
    }

    private static byte[] referenceRs256(byte[] modulus, byte[] exponent) {
        byte[] rsaKey = der(0x30, concat(integer(modulus), integer(exponent)));
        return der(0x30, concat(RSA_ALGORITHM, der(0x03, concat(new byte[] {0}, rsaKey))));
    }

    private static byte[] der(int tag, byte[] content) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(tag);
        int length = content.length;
        if (length < 0x80) {
            out.write(length);
        } else {
            byte[] bytes = BigInteger.valueOf(length).toByteArray();
            int start = bytes[0] == 0 ? 1 : 0;
            out.write(0x80 | (bytes.length - start));
            out.write(bytes, start, bytes.length - start);
        }
        out.writeBytes(content);
        return out.toByteArray();
    }

    private static byte[] integer(byte[] unsigned) {
        int start = 0;
        while (start < unsigned.length && unsigned[start] == 0) {
            start++;
        }
        byte[] value;
        if (start == unsigned.length || (unsigned[start] & 0x80) != 0) {
            value = new byte[unsigned.length - start + 1];
            System.arraycopy(unsigned, start, value, 1, unsigned.length - start);
        } else {
            value = new byte[unsigned.length - start];
            System.arraycopy(unsigned, start, value, 0, value.length);
        }
        return der(0x02, value);
    }

    private static byte[] unsigned(BigInteger value) {
        byte[] bytes = value.toByteArray();
        int start = 0;
        while (start < bytes.length - 1 && bytes[start] == 0) {
            start++;
        }
        return Arrays.copyOfRange(bytes, start, bytes.length);
    }

    private static byte[] pad(byte[] bytes, int size) {
        if (bytes.length >= size) {
            return bytes;
        }
        byte[] out = new byte[size];
        System.arraycopy(bytes, 0, out, size - bytes.length, bytes.length);
        return out;
    }

    private static byte[] concat(byte[]... parts) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] part : parts) {
            out.writeBytes(part);
        }
        return out.toByteArray();
    }
}
