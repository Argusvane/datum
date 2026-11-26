package com.argusvane.datum.tck;

import java.util.Locale;

/**
 * What a host under test serves and how it was configured, so {@link HostTck} knows which contracts to run. A test
 * class that implements a contract interface declares its capability by doing so; the runner reads them from
 * {@code datum.tck.capabilities}.
 */
public enum Capability {

    /** Story one with the kit's fixture form ({@link TckFixtures#FORM}): {@code POST /submissions}, {@code /validate}. */
    SUBMISSIONS,

    /** The dry-run route {@code POST /submissions/test} is on ({@code datum.web.api.endpoints.test=true}). */
    SUBMISSIONS_TEST,

    /** The flood limits, per form and per address: the contract posts until it is refused, so it runs last and only when asked for. */
    FLOOD,

    /** The definition reads of the fixture form ({@code GET /forms/{key}/definition}). */
    FORMS,

    /** Story two: the versioned assets, {@code host.json} and the glue. */
    ASSETS,

    /** The server PDF routes, with the fixture form. */
    PDF,

    /** The RFC 3161 timestamp server. */
    TSA,

    /** The passkey endpoints, with a form that asks for a signature and two signed-in people. */
    PASSKEYS,

    /** The builder's write routes, with a person who may build. */
    BUILDER,

    /**
     * The kit's hostile rule module is registered for the fixture form ({@link TckFixtures#HARDENING_RULES}): the
     * hardening subset over HTTP ({@link HardeningContract}). A test deployment only.
     */
    HARDENING,

    /** A runtime that could not prove its program: every submission is 503. */
    RUNTIME_DOWN,

    /**
     * The host judges {@code host.} rules with a context it works out itself: the kit's host context fixture
     * ({@link TckFixtures#HOST_CONTEXT_FORM}) is served, the dry-run route is on, and a TEST-ONLY provider answers
     * {@code {"role": <X-Datum-Test-Role>}} for that form ({@link HostContextContract}). A test deployment only.
     */
    HOST_CONTEXT;

    /** The name in {@code datum.tck.capabilities} ({@code submissions-test} for {@link #SUBMISSIONS_TEST}). */
    public String key() {
        return name().toLowerCase(Locale.ROOT).replace('_', '-');
    }

    /** The capability named {@code key} (either spelling). */
    public static Capability of(String key) {
        return valueOf(key.strip().toUpperCase(Locale.ROOT).replace('-', '_'));
    }
}
