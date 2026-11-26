package com.argusvane.datum.webauthn.web;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;

/** The MVC test application (MockMvc); the passkey properties are the test class's, from passkeys-main.properties and its own. */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
@SpringBootTest(classes = PasskeysMvcTestApp.class, properties = "spring.main.web-application-type=servlet")
@AutoConfigureMockMvc
@interface MvcApp {
}
