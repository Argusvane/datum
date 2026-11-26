package com.argusvane.datum.pdf.web;

import com.argusvane.datum.pdf.spring.PdfWebStackImports;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.context.annotation.Import;

/**
 * An application with Datum's shared web module and the PDF endpoints' stack configurations, over the collaborators
 * in {@link PdfWebTestBeans}. The other capabilities' auto-configurations (forms, submissions) are left out: they
 * need a real runtime, which the example's integration test boots.
 */
@SpringBootConfiguration
@EnableAutoConfiguration(
    exclude = {com.argusvane.datum.forms.spring.DatumFormsAutoConfiguration.class,
        com.argusvane.datum.sandbox.spring.DatumSandboxAutoConfiguration.class,
        com.argusvane.datum.submissions.spring.DatumSubmissionsAutoConfiguration.class,
        com.argusvane.datum.pdf.spring.DatumPdfAutoConfiguration.class},
    excludeName = {"com.argusvane.datum.forms.spring.DatumFormsWebAutoConfiguration",
        "com.argusvane.datum.forms.spring.DatumFormsOpenApiAutoConfiguration",
        "com.argusvane.datum.submissions.spring.DatumSubmissionsOpenApiAutoConfiguration"})
@Import({PdfWebTestBeans.class, PdfWebStackImports.class})
public class PdfWebTestApp {
}
