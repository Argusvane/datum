package com.argusvane.datum.examples.submissions;

import com.argusvane.datum.starter.test.DatumTck;
import com.argusvane.datum.tck.HostTarget;
import com.argusvane.datum.tck.RuntimeDownContract;
import org.junit.jupiter.api.Tag;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

/**
 * {@code abi_mismatch} over HTTP (integrations/jvm/README.md "Libraries and bindings"): started with the host test kit's stale sandbox
 * program (ABI 2.11.0, below the floor) as its override and fail-fast off, the application starts, the runtime refuses
 * the program at the ABI probe, and every submission is answered 503 (the kit's runtime-down contract), never judged by
 * an older kernel.
 */
@Tag("real-runtime")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "datum.runtime.fail-fast=false",
    "datum.runtime.programs.sandbox=" + DatumTck.STALE_PROGRAM_LOCATION})
class SubmissionsStaleProgramIT implements RuntimeDownContract {

    @LocalServerPort
    int port;

    @Override
    public HostTarget target() {
        return DatumTck.local(port);
    }
}
