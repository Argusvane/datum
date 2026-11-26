package com.argusvane.datum.examples.builderjpa;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;

/** One line of the form audit log: which form moved from which version to which, and when. */
@Entity
@Table(name = "example_form_audit")
public class FormAuditEntry {

    @Id
    @GeneratedValue
    private Long id;

    @Column(name = "form_key", length = 128, nullable = false)
    private String formKey;

    @Column(name = "sha256", length = 64, nullable = false)
    private String sha256;

    @Column(name = "previous_sha256", length = 64)
    private String previousSha256;

    @Column(name = "saved_at", nullable = false)
    private Instant savedAt;

    protected FormAuditEntry() {
    }

    public FormAuditEntry(String formKey, String sha256, String previousSha256, Instant savedAt) {
        this.formKey = formKey;
        this.sha256 = sha256;
        this.previousSha256 = previousSha256;
        this.savedAt = savedAt;
    }

    public String getFormKey() {
        return formKey;
    }

    public String getSha256() {
        return sha256;
    }

    public String getPreviousSha256() {
        return previousSha256;
    }
}
