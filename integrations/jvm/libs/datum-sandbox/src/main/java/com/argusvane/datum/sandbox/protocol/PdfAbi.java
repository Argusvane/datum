package com.argusvane.datum.sandbox.protocol;

/**
 * The PDF program ABI this host needs.
 *
 * <p>A program of the same major version answers ({@code pdfAbiCompatible} in
 * {@code engine/form-engine/render/pdf/pdf-abi.ts}); the host also needs at least {@link #MIN}, since the requests
 * it sends read what that version added. This host starts at 4.0.0, the ABI of the program it ships (the design-system
 * bindings major, which no 3.x program speaks).
 */
public final class PdfAbi {

    /** The ABI the host's requests name, and the oldest program it works with. */
    public static final String MIN = "4.0.0";

    private PdfAbi() {
    }

    /**
     * Whether the host works with a PDF program that reports this ABI: the same major version as {@link #MIN},
     * and not older than it ({@code pdfAbiCompatible} and the host's floor).
     */
    public static boolean speaks(String abi) {
        if (abi == null) {
            return false;
        }
        int[] version = Versions.parse(abi);
        int[] min = Versions.parse(MIN);
        if (version == null || min == null) {
            return false;
        }
        return version[0] == min[0] && Versions.compare(version, min) >= 0;
    }
}
