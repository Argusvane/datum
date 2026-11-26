package com.argusvane.datum.tck;

import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.TestMethodOrder;
import org.junit.jupiter.api.extension.ExtendWith;

/**
 * What every contract needs: the host under test. A test class implements one or more contract interfaces and
 * answers {@link #target()}. The methods run by {@code @Order}: the contracts number their tests, the stateful ones
 * (a redelivery, a builder save) build on earlier answers, and the flood contract, which spends the request budget,
 * runs last. JUnit reads the {@code @TestMethodOrder} declared here for every implementing class, so a class needs
 * no annotation of its own; one that names a different orderer is refused before its first test
 * ({@link ContractOrderCheck}), because a random or alphabetical order would let the flood contract throttle the rest.
 *
 * <p>Numbering: submissions 1100, dry run 1150, forms 1200, assets 1300, PDF 1400, timestamp 1500, passkeys 1600,
 * builder 1700, hardening 1800, runtime down 1900, host context 1950, flood {@code Order.DEFAULT + 9000} (the per-form
 * limit) and {@code Order.DEFAULT + 9001} (the address limit). A host's own tests use numbers below 1000;
 * an own test without {@code @Order} gets {@code Order.DEFAULT}, so it runs after the contracts and still before
 * the flood contract.
 */
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
@ExtendWith(ContractOrderCheck.class)
public interface HostContract {

    /** The host under test. */
    HostTarget target();

    /** Requests to it. */
    default HostHttp http() {
        return new HostHttp(target());
    }
}
