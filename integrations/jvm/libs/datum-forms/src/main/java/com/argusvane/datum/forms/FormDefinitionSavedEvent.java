package com.argusvane.datum.forms;

/**
 * Published after a definition was stored (and snapshotted). {@code previousSha256} is null for the first
 * version of a form. Listeners (cache warmers, audit logs) must not assume the sender's thread.
 *
 * <p>Delivery: synchronously on the thread that saved, with Spring's default multicaster, after the
 * repository's save and the snapshot. Datum opens no transaction of its own; a caller of {@code DefinitionService.saved}
 * inside one (a batch import) has the event published inside it, before the commit, so a listener that must see the
 * committed row is a {@code @TransactionalEventListener(fallbackExecution = true)}. A listener that throws is logged and
 * never changes the save's answer (no save warning either); it cannot veto (a rule that refuses a save is a
 * {@code BuilderSaveValidator}).
 */
public record FormDefinitionSavedEvent(String key, String sha256, String previousSha256) {
}
