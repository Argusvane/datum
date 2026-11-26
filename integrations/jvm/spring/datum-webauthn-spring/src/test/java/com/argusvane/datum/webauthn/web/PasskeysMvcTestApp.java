package com.argusvane.datum.webauthn.web;

import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.context.annotation.Import;

/** An MVC application with the passkey module's auto-configuration (datum-submissions and datum-sandbox-spring switched off: no sandbox here). */
@SpringBootConfiguration
@EnableAutoConfiguration(excludeName = {
    "com.argusvane.datum.sandbox.spring.DatumSandboxAutoConfiguration",
    "com.argusvane.datum.submissions.spring.DatumSubmissionsAutoConfiguration",
    "com.argusvane.datum.submissions.spring.DatumSubmissionsOpenApiAutoConfiguration"})
@Import(PasskeysTestBeans.class)
public class PasskeysMvcTestApp {
}
