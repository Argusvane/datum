package com.argusvane.datum.examples.builderjpa;

import com.argusvane.datum.forms.FormDefinitionSavedEvent;
import java.time.Clock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;

/**
 * Listens for {@link FormDefinitionSavedEvent}: published once per stored version, after the kernel accepted it and
 * the snapshot was recorded. A real application would warm a cache, notify approvers or start a publication
 * workflow here; this one writes an audit row. The event is published on the saving request's thread; a listener
 * that throws is logged by the packages and does not undo the save.
 */
public class FormSavedAudit {

    private static final Logger LOG = LoggerFactory.getLogger(FormSavedAudit.class);

    private final FormAuditEntries audit;
    private final Clock clock;

    public FormSavedAudit(FormAuditEntries audit, Clock clock) {
        this.audit = audit;
        this.clock = clock;
    }

    @EventListener
    public void onSaved(FormDefinitionSavedEvent event) {
        LOG.info("Form {} saved: {} (was {}).", event.key(), event.sha256(), event.previousSha256());
        audit.save(new FormAuditEntry(event.key(), event.sha256(), event.previousSha256(), clock.instant()));
    }
}
