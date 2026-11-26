package com.argusvane.datum.submissions.web;

import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.context.annotation.Import;

/** An WebFlux application with the submissions module's auto-configuration and the test beans. */
@SpringBootConfiguration
@EnableAutoConfiguration
@Import(WebTestBeans.class)
public class SubmissionsFluxTestApp {
}
