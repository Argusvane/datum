package com.argusvane.datum.timestamp.web;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/** datum.tsa.path=/stamp: every expectation of the open server holds at the new path, and the old one is not mapped. */
public abstract class CustomPathContract extends OpenContract {

    @Override
    protected String path() {
        return "/stamp";
    }

    @Test
    void theDefaultPathIsNotMapped() {
        assertThat(send("POST", "/tsa", new byte[] {1}, "Content-Type", QUERY).status()).isEqualTo(404);
        assertThat(get("/tsa/certificate").status()).isEqualTo(404);
    }
}
