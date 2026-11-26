package com.argusvane.datum.timestamp.web;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** An application-supplied time source: the binding's default backs off ({@code @ConditionalOnMissingBean}). */
@Configuration(proxyBeanMethods = false)
public class TimeSourceTestBeans {

    @Bean
    SwitchableTimeSource switchableTimeSource() {
        return new SwitchableTimeSource();
    }
}
