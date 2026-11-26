package com.argusvane.datum.ui.builder;

/**
 * What {@link BuilderApi} hands a web adapter once a write may go on to read its body: the operation and the form
 * key (null for a create, whose key is in the body). Only {@link BuilderApi} makes one, so an adapter cannot reach a
 * save without the existence check having run first. Who may write at all is the application's security, in front
 * of the route (framework-first).
 */
public final class Admission {

    /** The three write endpoints. */
    public enum Operation {
        CREATE, UPDATE, TRANSLATIONS
    }

    private final Operation operation;
    private final String key;

    Admission(Operation operation, String key) {
        this.operation = operation;
        this.key = key;
    }

    public Operation operation() {
        return operation;
    }

    /** The form key from the path, or null for a create. */
    public String key() {
        return key;
    }
}
