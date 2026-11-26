package com.argusvane.datum.forms.web;

import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.context.annotation.Import;

/** A WebFlux application with the forms module's auto-configuration and the test beans. */
@SpringBootConfiguration
@EnableAutoConfiguration
@Import(FormsTestBeans.class)
public class FormsFluxTestApp {
}
