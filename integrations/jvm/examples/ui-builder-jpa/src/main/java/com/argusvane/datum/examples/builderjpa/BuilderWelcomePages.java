package com.argusvane.datum.examples.builderjpa;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.ViewControllerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * Makes {@code /builder} and {@code /builder/} open the builder page. Spring Boot's welcome page covers only the
 * site root, so a directory under static resources answered 404 and only {@code /builder/index.html} served. The
 * forward keeps the address bar on the short link the pages use, and the security chain still asks for a sign-in
 * first ({@code /builder/**}).
 */
@Configuration(proxyBeanMethods = false)
public class BuilderWelcomePages implements WebMvcConfigurer {

    @Override
    public void addViewControllers(ViewControllerRegistry registry) {
        registry.addViewController("/builder").setViewName("forward:/builder/index.html");
        registry.addViewController("/builder/").setViewName("forward:/builder/index.html");
    }
}
