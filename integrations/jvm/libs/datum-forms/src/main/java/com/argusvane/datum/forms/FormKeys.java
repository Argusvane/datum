package com.argusvane.datum.forms;

import com.argusvane.datum.core.FormKeyRule;
import java.util.regex.Pattern;

/**
 * What a form key may be, in one place (integrations/jvm/README.md "Libraries and bindings"): it is a URL path segment and the snapshot table's {@code form_key VARCHAR(128)}, so 1 to 128 letters,
 * digits, dots, hyphens or underscores. The resource repository refuses to start on a file with another key, and
 * the read endpoints answer 404 for one without reaching a repository.
 */
public final class FormKeys {

    /** {@code ^[A-Za-z0-9_.-]{1,128}$}: {@link FormKeyRule#PATTERN}, the rule the binding table's route keys follow too. */
    public static final Pattern PATTERN = FormKeyRule.PATTERN;

    private FormKeys() {
    }

    /** Whether {@code key} is a form key. */
    public static boolean isValid(String key) {
        return FormKeyRule.isValid(key);
    }

    /**
     * Refuses a definition file whose key is not a form key, naming the file.
     *
     * @param where how the file is named in the message (its URL)
     * @throws IllegalStateException when the key is not valid
     */
    public static String validate(String key, String where) {
        if (!isValid(key)) {
            throw new IllegalStateException("The form definition " + where + " has the key \"" + key
                + "\", which is not 1 to 128 letters, digits, dots, hyphens or underscores. Rename the file or change its id.");
        }
        return key;
    }
}
