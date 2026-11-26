package com.argusvane.datum.timestamp.web;

import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.context.annotation.Import;

/** An MVC application with the timestamp module's auto-configuration. */
@SpringBootConfiguration
@EnableAutoConfiguration
@Import(TsaTestBeans.class)
public class TsaMvcTestApp {
}
