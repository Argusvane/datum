package com.argusvane.datum.timestamp.web;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * The beans every web test adds to the application: the event collector, and an application TimestampRequestCustomizer
 * that is inert unless a request's digest is that of {@link #REFUSED} (a hook refusal) or {@link #FAILING}
 * (a customizer that throws).
 */
@Configuration(proxyBeanMethods = false)
public class TsaTestBeans {

    /** Data whose digest the customizer refuses. */
    static final byte[] REFUSED = "a digest on the deny list".getBytes(java.nio.charset.StandardCharsets.UTF_8);
    /** Data whose digest makes the customizer throw. */
    static final byte[] FAILING = "a digest the policy service cannot judge".getBytes(java.nio.charset.StandardCharsets.UTF_8);

    @Bean
    com.argusvane.datum.timestamp.TimestampRequestCustomizer denyList() {
        return draft -> {
            if (java.util.Arrays.equals(draft.hash(), sha256(REFUSED))) {
                throw com.argusvane.datum.core.hooks.HookRefusedException.forbidden("tsa.denied", "This digest is on the deny list.");
            }
            if (java.util.Arrays.equals(draft.hash(), sha256(FAILING))) {
                throw new IllegalStateException("the policy service is down /secret/path");
            }
        };
    }

    static byte[] sha256(byte[] data) {
        try {
            return java.security.MessageDigest.getInstance("SHA-256").digest(data);
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    @Bean
    EventLog eventLog() {
        return new EventLog();
    }
}
