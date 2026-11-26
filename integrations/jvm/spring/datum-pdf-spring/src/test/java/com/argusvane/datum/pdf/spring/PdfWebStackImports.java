package com.argusvane.datum.pdf.spring;

import org.springframework.context.annotation.ImportSelector;
import org.springframework.core.type.AnnotationMetadata;

/**
 * Lets a test in another package import the PDF endpoints' two stack configurations. They are package-private on
 * purpose (an imported configuration is not API), so the test names them here, in
 * their own package, instead of widening them.
 */
public final class PdfWebStackImports implements ImportSelector {

    @Override
    public String[] selectImports(AnnotationMetadata importingClassMetadata) {
        return new String[] {PdfWebConfiguration.Mvc.class.getName(), PdfWebConfiguration.Reactive.class.getName()};
    }
}
