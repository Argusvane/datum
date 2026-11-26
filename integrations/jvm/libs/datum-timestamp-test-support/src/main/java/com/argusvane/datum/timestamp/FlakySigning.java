package com.argusvane.datum.timestamp;

import java.security.GeneralSecurityException;
import java.security.InvalidKeyException;
import java.security.InvalidParameterException;
import java.security.PrivateKey;
import java.security.Provider;
import java.security.PublicKey;
import java.security.Security;
import java.security.Signature;
import java.security.SignatureException;
import java.security.SignatureSpi;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * A JCA signature that fails on demand, for the one refusal no real key shows: the serial is taken, then signing
 * fails ("The timestamp server cannot sign now."). It serves only {@link Key} (an RSA key wrapped so the JDK's own
 * provider does not take it) and delegates to SunRsaSign until {@link #FAIL} is set; installed by {@link #install()}
 * and removed by closing what it returns.
 */
public final class FlakySigning extends SignatureSpi {

    /** Set: the next {@code sign()} throws, as a signing device that went away would. */
    static final AtomicBoolean FAIL = new AtomicBoolean();

    private static final String PROVIDER = "DatumFlakySigningTest";

    /** An RSA private key the JDK's providers do not recognise (no RSAPrivateKey interface, no encoding). */
    record Key(PrivateKey real) implements PrivateKey {
        private static final long serialVersionUID = 1L;

        @Override
        public String getAlgorithm() {
            return "RSA";
        }

        @Override
        public String getFormat() {
            return null;
        }

        @Override
        public byte[] getEncoded() {
            return null;
        }
    }

    static AutoCloseable install() {
        Provider provider = new Provider(PROVIDER, "1.0", "Datum timestamp tests: a signature that fails on demand") {
            private static final long serialVersionUID = 1L;

            {
                putService(new Provider.Service(this, "Signature", "SHA256withRSA", FlakySigning.class.getName(), null,
                    Map.of("SupportedKeyClasses", Key.class.getName())));
            }
        };
        Security.addProvider(provider);
        return () -> {
            Security.removeProvider(PROVIDER);
            FAIL.set(false);
        };
    }

    private Signature delegate;

    public FlakySigning() {
    }

    @Override
    protected void engineInitSign(PrivateKey key) throws InvalidKeyException {
        if (!(key instanceof Key flaky)) {
            throw new InvalidKeyException("not a test key");
        }
        try {
            delegate = Signature.getInstance("SHA256withRSA", "SunRsaSign");
            delegate.initSign(flaky.real());
        } catch (GeneralSecurityException e) {
            throw new InvalidKeyException(e);
        }
    }

    @Override
    protected void engineInitVerify(PublicKey key) throws InvalidKeyException {
        throw new InvalidKeyException("sign only");
    }

    @Override
    protected void engineUpdate(byte b) throws SignatureException {
        delegate.update(b);
    }

    @Override
    protected void engineUpdate(byte[] b, int off, int len) throws SignatureException {
        delegate.update(b, off, len);
    }

    @Override
    protected byte[] engineSign() throws SignatureException {
        if (FAIL.get()) {
            throw new SignatureException("the signing device went away");
        }
        return delegate.sign();
    }

    @Override
    protected boolean engineVerify(byte[] sigBytes) throws SignatureException {
        throw new SignatureException("sign only");
    }

    @Override
    @Deprecated
    protected void engineSetParameter(String param, Object value) {
        throw new InvalidParameterException("no parameters");
    }

    @Override
    @Deprecated
    protected Object engineGetParameter(String param) {
        throw new InvalidParameterException("no parameters");
    }
}
