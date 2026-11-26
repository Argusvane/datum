package com.argusvane.datum.timestamp.web;

import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.context.annotation.Import;

/** An WebFlux application with the timestamp module's auto-configuration. */
@SpringBootConfiguration
@EnableAutoConfiguration
@Import(TsaTestBeans.class)
public class TsaFluxTestApp {
}
