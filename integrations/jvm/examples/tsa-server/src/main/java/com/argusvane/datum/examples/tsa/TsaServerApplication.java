package com.argusvane.datum.examples.tsa;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * An RFC 3161 timestamp server and nothing else. Everything it does comes from
 * {@code datum-spring-boot-starter-timestamp} and {@code application.yml}: no controller, no service, no bean
 * of this application's own.
 */
@SpringBootApplication
public class TsaServerApplication {

    public static void main(String[] args) {
        SpringApplication.run(TsaServerApplication.class, args);
    }
}
