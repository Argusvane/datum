package com.argusvane.datum.forms.snapshot;

/**
 * A definition was stored but its snapshot could not be recorded: {@link DefinitionSnapshotStore#record} failed (a
 * read-only database user, a lost connection), and that failure is the cause. Thrown by
 * {@code DefinitionService.saved} where the store fails, so a caller tells it apart from anything else that fails after
 * the snapshot was recorded (an application's own event publisher, which owns its failure). The builder's
 * save answers it with its "could not record this version" warning, the version being recorded again on the next read.
 *
 * <p>The message names the form and the hash, never the store's words (they can quote SQL or a connection string); the
 * cause carries them for the log.
 */
public final class SnapshotNotRecordedException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final String key;
    private final String sha256;

    public SnapshotNotRecordedException(String key, String sha256, Throwable cause) {
        super("The snapshot of form " + key + " at " + sha256 + " could not be recorded.", cause);
        this.key = key;
        this.sha256 = sha256;
    }

    /** The form whose snapshot was not recorded. */
    public String key() {
        return key;
    }

    /** The hash that was not recorded. */
    public String sha256() {
        return sha256;
    }
}
