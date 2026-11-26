package com.argusvane.datum.tck;

import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.TestMethodOrder;
import org.junit.jupiter.api.extension.BeforeAllCallback;
import org.junit.jupiter.api.extension.ExtensionConfigurationException;
import org.junit.jupiter.api.extension.ExtensionContext;

/**
 * Refuses a contract class whose own {@code @TestMethodOrder} (or a superclass's) names an orderer other than
 * {@code @Order}. Without one the class inherits {@link HostContract}'s; with another one the flood contract could
 * run first and turn every later contract into a 429, which reads as a host fault rather than a test set-up fault.
 */
public final class ContractOrderCheck implements BeforeAllCallback {

    @Override
    public void beforeAll(ExtensionContext context) {
        Class<?> testClass = context.getRequiredTestClass();
        for (Class<?> type = testClass; type != null && type != Object.class; type = type.getSuperclass()) {
            TestMethodOrder order = type.getDeclaredAnnotation(TestMethodOrder.class);
            if (order != null) {
                if (order.value() != MethodOrderer.OrderAnnotation.class) {
                    throw new ExtensionConfigurationException(testClass.getName() + " implements a Datum host contract and orders its"
                        + " methods by " + order.value().getSimpleName() + "; the contracts need MethodOrderer.OrderAnnotation"
                        + " (remove the annotation: HostContract declares it)");
                }
                return;
            }
        }
    }
}
