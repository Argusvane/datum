package com.argusvane.datum.webauthn.spring;

import static org.assertj.core.api.Assertions.assertThat;

import com.argusvane.datum.webauthn.web.PasskeysMvcTestApp;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.test.context.TestPropertySource;

/** An application that has a TaskScheduler gets the purge on it. */
@SpringBootTest(classes = {PasskeysMvcTestApp.class, PasskeyPurgeWiringTest.Scheduling.class}, properties = "spring.main.web-application-type=servlet")
@TestPropertySource(locations = "classpath:passkeys-main.properties", properties = "datum.webauthn.allow-memory-stores=true")
class PasskeyPurgeWiringTest {

    @Configuration(proxyBeanMethods = false)
    static class Scheduling {

        @Bean
        TaskScheduler taskScheduler() {
            ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
            scheduler.setPoolSize(1);
            return scheduler;
        }
    }

    @Autowired
    PasskeyPurgeSchedule schedule;

    @Test
    void thePurgeIsScheduledOnTheApplicationsScheduler() {
        assertThat(schedule.scheduled()).isTrue();
    }
}
