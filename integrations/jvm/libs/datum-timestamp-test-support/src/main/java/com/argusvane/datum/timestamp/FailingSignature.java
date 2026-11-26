package com.argusvane.datum.timestamp;

import java.time.Instant;

/**
 * Lets tests outside this package see the one refusal no real key shows: a signature that fails after the serial
 * is taken. {@link #run} builds an authority whose first token fails to sign (the serial is taken first) and
 * whose later tokens sign normally.
 */
public final class FailingSignature {

    /** What a test does with the authority. */
    public interface Body {
        void accept(TimestampAuthority authority) throws Exception;
    }

    private FailingSignature() {
    }

    public static void run(TsaSerialAllocator real, Body body) throws Exception {
        TsaKey good = Fixtures.key("tsa");
        TsaKey flaky = new TsaKey(new FlakySigning.Key(good.privateKey()), good.chain());
        TsaSerialAllocator failFirst = entry -> {
            long serial = real.allocate(entry);
            FlakySigning.FAIL.set(serial == 1);
            return serial;
        };
        try (AutoCloseable installed = FlakySigning.install()) {
            body.accept(new TimestampAuthority(TsaKeyMaterial.of(flaky), null, null, Fixtures.clock(Fixtures.OCT_5), failFirst));
        }
    }

    /** The instant the authority's clock reads. */
    public static Instant now() {
        return Fixtures.OCT_5;
    }
}
