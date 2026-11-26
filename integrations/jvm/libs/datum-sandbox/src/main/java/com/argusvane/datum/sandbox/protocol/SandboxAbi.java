package com.argusvane.datum.sandbox.protocol;

/**
 * The sandbox program ABI this host needs.
 *
 * <p>Hand-maintained, never read from a manifest: the requests the host sends name it, and
 * the startup probe ({@link AbiProbe}) refuses a program that does not answer for it ({@code abi_mismatch}),
 * so a program file of another ABI on the classpath never judges a submission.
 */
public final class SandboxAbi {

    /**
     * The sandbox program ABI this host's requests name: a program of this major, at this version or later, answers.
     * 4.1.0 is the first that reads {@code hostContext} and judges journeys as the browser does now (a page with a
     * {@code when} refused, Check answers pages, Continue checking deferred to the end by default).
     */
    public static final String MIN = "4.1.0";

    private SandboxAbi() {
    }
}
