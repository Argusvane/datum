package com.argusvane.datum.examples.submissions;

import com.argusvane.datum.starter.test.DatumTck;
import com.argusvane.datum.tck.HostTarget;
import com.argusvane.datum.tck.RuntimeDownContract;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

/**
 * The 503 of the README: with a sandbox program that cannot be read and fail-fast off, the application starts, the
 * runtime is DOWN and every submission is answered 503 {@code server.unavailable} (never accepted unchecked), with no
 * engine run at all. The assertion is the host test kit's runtime-down contract.
 */
@Tag("real-runtime")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "datum.runtime.fail-fast=false",
    "datum.runtime.programs.sandbox=file:/definitely/not/a/program.js"})
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class SubmissionsExampleDownIT implements RuntimeDownContract {

    @LocalServerPort
    int port;

    @Override
    public HostTarget target() {
        return DatumTck.local(port);
    }
}
