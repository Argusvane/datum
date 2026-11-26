package com.argusvane.datum.ui.builder;

import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.context.annotation.Import;

/** An application with every Datum auto-configuration and the builder test beans; the stack is chosen by a property. */
@SpringBootConfiguration
@EnableAutoConfiguration
@Import(BuilderTestBeans.class)
public class BuilderTestApp {
}
