package com.argusvane.datum.core.canonical;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;

/**
 * ECMAScript's {@code Number::toString} for a double (ECMA-262 section 6.1.6.1.20; RFC 8785 section 3.2.2.3),
 * the one formatter {@link CanonicalJson} and {@link Jcs} share so the host's digest and signed text equal the
 * sandbox program's and the browser's byte for byte.
 *
 * <p>It does not lean on {@link Double#toString}: before JDK 19 that is not always the shortest digit string and
 * its exponent thresholds differ, and this must be identical on JDK 17, 21 and 25. The digits come from exact
 * arithmetic instead: the interval of reals that read back as the double (half way to each neighbour, ends
 * included only when the mantissa is even, as round-half-even reads them) is held as {@link BigDecimal}s, and
 * the first precision with a decimal inside it supplies the digits. When both the round-down and the round-up
 * decimal at that precision read back, the closer one wins and an exact tie takes the even last digit, which is
 * the specification's own tie rule (and the case a nearest-decimal search misses: just above a power of two the
 * nearest p-digit decimal may fall outside the narrower lower half of the interval).
 *
 * <p>Written for this project; it ports no third-party algorithm. {@code integrations/shared/scripts/number-oracle.mjs}
 * generates the node-checked fixture the tests hold it to.
 */
final class EcmaNumber {

    private static final double TWO_POW_53 = 9007199254740992.0;
    private static final BigDecimal HALF = new BigDecimal("0.5");

    private EcmaNumber() {
    }

    /** {@code value} as JavaScript writes it; NaN and the infinities as {@code null}, both zeros as {@code 0}. */
    static String format(double value) {
        if (Double.isNaN(value) || Double.isInfinite(value)) {
            return "null";
        }
        if (value == 0.0) {
            return "0";
        }
        double magnitude = Math.abs(value);
        String sign = value < 0 ? "-" : "";
        // An integer below 2^53 is exact and its neighbours are at least 1 apart: all its digits are needed.
        if (magnitude < TWO_POW_53 && magnitude == Math.rint(magnitude)) {
            return sign + (long) magnitude;
        }
        BigDecimal shortest = shortest(magnitude);
        BigDecimal stripped = shortest.stripTrailingZeros();
        String digits = stripped.unscaledValue().toString();
        int k = digits.length();
        // value = 0.<digits> x 10^n in ECMAScript's terms: digits x 10^(n - k).
        int n = k - stripped.scale();
        String text;
        if (k <= n && n <= 21) {
            text = digits + "0".repeat(n - k);
        } else if (0 < n && n <= 21) {
            text = digits.substring(0, n) + "." + digits.substring(n);
        } else if (-6 < n && n <= 0) {
            text = "0." + "0".repeat(-n) + digits;
        } else {
            int e = n - 1;
            text = (k == 1 ? digits : digits.charAt(0) + "." + digits.substring(1)) + "e" + (e < 0 ? "-" : "+") + Math.abs(e);
        }
        return sign + text;
    }

    /** The shortest decimal that reads back as {@code v} (positive, finite), closest to it among that length. */
    private static BigDecimal shortest(double v) {
        BigDecimal exact = new BigDecimal(v);
        // Half way to each neighbour: the gap below is the neighbour's own ulp (narrower at a power of two).
        BigDecimal low = exact.subtract(new BigDecimal(Math.ulp(Math.nextDown(v))).multiply(HALF));
        BigDecimal high = exact.add(new BigDecimal(Math.ulp(v)).multiply(HALF));
        boolean evenMantissa = (Double.doubleToRawLongBits(v) & 1L) == 0;
        for (int precision = 1; precision <= 17; precision++) {
            BigDecimal down = exact.round(new MathContext(precision, RoundingMode.FLOOR));
            BigDecimal up = exact.round(new MathContext(precision, RoundingMode.CEILING));
            boolean downReads = reads(down, low, high, evenMantissa);
            boolean upReads = reads(up, low, high, evenMantissa);
            if (downReads && upReads && down.compareTo(up) != 0) {
                int closer = exact.subtract(down).compareTo(up.subtract(exact));
                if (closer < 0) {
                    return down;
                }
                if (closer > 0) {
                    return up;
                }
                return lastDigitEven(down) ? down : up;
            }
            if (downReads) {
                return down;
            }
            if (upReads) {
                return up;
            }
        }
        // 17 significant digits always identify a double; reaching here would mean the interval is wrong.
        return exact.round(new MathContext(17, RoundingMode.HALF_EVEN));
    }

    private static boolean reads(BigDecimal candidate, BigDecimal low, BigDecimal high, boolean endsIncluded) {
        int vsLow = candidate.compareTo(low);
        int vsHigh = candidate.compareTo(high);
        return (vsLow > 0 || (endsIncluded && vsLow == 0)) && (vsHigh < 0 || (endsIncluded && vsHigh == 0));
    }

    private static boolean lastDigitEven(BigDecimal candidate) {
        return !candidate.unscaledValue().testBit(0);
    }
}
