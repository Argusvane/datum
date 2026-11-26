package com.argusvane.datum.examples.builderjpa;

import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

/** Spring Data access to {@link FormAuditEntry}. */
public interface FormAuditEntries extends JpaRepository<FormAuditEntry, Long> {

    List<FormAuditEntry> findByFormKeyOrderByIdAsc(String formKey);
}
