package com.argusvane.datum.examples.builderjpa;

import org.springframework.data.jpa.repository.JpaRepository;

/** Spring Data access to {@link FormEntity}. The application's own queries (a form list, say) belong here, not in Datum. */
public interface FormEntities extends JpaRepository<FormEntity, String> {
}
