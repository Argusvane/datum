package com.argusvane.datum.tck;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.DataFormatException;
import java.util.zip.Inflater;

/**
 * The fill colours a PDF sets ({@code r g b rg}, each component 0 to 1), read from its bytes: the text outside streams
 * and every stream, inflated when it is Flate-compressed (a page's content stream is, as the PDF program writes it).
 * The per-route binding test ({@link PdfContract}) looks for the kit's PDF theme's text colour here: what the PDF was
 * drawn under, not what a header says. The Node kit reads a PDF the same way ({@code pdf-colours.ts}).
 */
public final class PdfColours {

    private static final Pattern OPENING = Pattern.compile("(?<!end)stream\\r?\\n");
    private static final String NUMBER = "(-?(?:\\d+\\.?\\d*|\\.\\d+))";
    private static final Pattern FILL = Pattern.compile("(?<![\\w.])" + NUMBER + "\\s+" + NUMBER + "\\s+" + NUMBER + "\\s+rg(?!\\w)");

    private PdfColours() {
    }

    /** Every fill colour the PDF sets. */
    public static List<double[]> fillColours(byte[] pdf) {
        String whole = new String(pdf, StandardCharsets.ISO_8859_1);
        List<String> texts = new ArrayList<>();
        texts.add(whole);
        Matcher opening = OPENING.matcher(whole);
        int from = 0;
        while (opening.find(from)) {
            int start = opening.end();
            int end = whole.indexOf("endstream", start);
            if (end < 0) {
                break;
            }
            String inflated = inflate(pdf, start, end - start);
            if (inflated != null) {
                texts.add(inflated);
            }
            from = end;
        }
        List<double[]> found = new ArrayList<>();
        for (String text : texts) {
            Matcher fill = FILL.matcher(text);
            while (fill.find()) {
                found.add(new double[] {Double.parseDouble(fill.group(1)), Double.parseDouble(fill.group(2)), Double.parseDouble(fill.group(3))});
            }
        }
        return found;
    }

    /** Whether the PDF sets the fill colour {@code #rrggbb} anywhere (each component within 0.002, a PDF writer's rounding). */
    public static boolean setsFillColour(byte[] pdf, String hex) {
        if (!hex.matches("#[0-9A-Fa-f]{6}")) {
            throw new IllegalArgumentException("not a #rrggbb colour: " + hex);
        }
        double[] wanted = new double[3];
        for (int i = 0; i < 3; i++) {
            wanted[i] = Integer.parseInt(hex.substring(1 + 2 * i, 3 + 2 * i), 16) / 255.0;
        }
        return fillColours(pdf).stream().anyMatch(colour -> Math.abs(colour[0] - wanted[0]) <= 0.002
            && Math.abs(colour[1] - wanted[1]) <= 0.002 && Math.abs(colour[2] - wanted[2]) <= 0.002);
    }

    /** The stream's bytes inflated as Latin-1 text; null when they are not Flate data. */
    private static String inflate(byte[] pdf, int offset, int length) {
        Inflater inflater = new Inflater();
        try {
            inflater.setInput(pdf, offset, length);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            while (!inflater.finished()) {
                int n = inflater.inflate(buffer);
                if (n == 0) {
                    if (inflater.needsInput() || inflater.needsDictionary()) {
                        break;
                    }
                }
                out.write(buffer, 0, n);
            }
            return out.size() == 0 ? null : out.toString(StandardCharsets.ISO_8859_1);
        } catch (DataFormatException e) {
            return null;
        } finally {
            inflater.end();
        }
    }
}
