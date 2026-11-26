package com.argusvane.datum.springweb.spring;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.argusvane.datum.sandbox.protocol.RunLog;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

/**
 * A guest's log line carries the form id as a key-value pair as well as the {@code [formId]}
 * prefix, so a structured log format lets an operator filter guest lines by form while a pattern log keeps the prefix.
 */
class RunLogKeyValueTest {

    @Test
    void theFormIdIsAFieldAndTheTextKeepsItsPrefixAndEscaping() {
        Logger log = (Logger) LoggerFactory.getLogger("datum.sandbox");
        ListAppender<ILoggingEvent> events = new ListAppender<>();
        events.start();
        log.addAppender(events);
        try {
            RunLog.slf4j().entry("contact\nform", "warn", "careful", null);
            assertThat(events.list).singleElement().satisfies(event -> {
                assertThat(event.getLevel().toString()).isEqualTo("WARN");
                assertThat(event.getFormattedMessage()).isEqualTo("[contact\\nform] careful");
                assertThat(event.getKeyValuePairs()).singleElement().satisfies(pair -> {
                    assertThat(pair.key).isEqualTo("formId");
                    assertThat(pair.value).isEqualTo("contact\\nform");
                });
            });
        } finally {
            log.detachAppender(events);
        }
    }
}
