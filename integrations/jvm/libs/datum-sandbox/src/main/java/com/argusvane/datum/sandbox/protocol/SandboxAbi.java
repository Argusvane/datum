package com.argusvane.datum.sandbox.protocol;

/**
 * The sandbox program ABI this host needs.
 *
 * <p>Hand-maintained, never read from a manifest: the requests the host sends name it, and
 * the startup probe ({@link AbiProbe}) refuses a program that does not answer for it ({@code abi_mismatch}),
 * so a program file of another ABI on the classpath never judges a submission.
 */
public final class SandboxAbi {

    /** The sandbox program ABI this host's requests name: a program of this major, at this version or later, answers. */
    public static final String MIN = "1.0.0";

    private SandboxAbi() {
    }
}
