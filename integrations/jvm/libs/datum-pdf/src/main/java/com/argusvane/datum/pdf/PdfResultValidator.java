package com.argusvane.datum.pdf;

import com.argusvane.datum.core.hooks.HookFindings;

/**
 * The application's own judgement of a PDF after the program made it and before its bytes leave (the PDF side
 * of the hook model): a page-count policy, a size policy, a check of the program's own warnings. Every bean runs, in the
 * framework's order (declare {@code @Order} where the relative order matters; equal orders keep registration order), on
 * every op that answers PDF bytes ({@code document}, {@code render}, {@code fill}, {@code sign}), all of them even when an
 * earlier one found errors. A PDF the server seals is judged before the seal, so a refused PDF costs no signature and no
 * timestamp; {@code complete} only embeds a signature into bytes a validator already let go, and is not judged again.
 *
 * <p>Errors refuse: no PDF leaves, no {@link PdfRenderedEvent} is published, and the request answers
 * {@link com.argusvane.datum.core.hooks.HookRefusedException} {@code INVALID} with every error in order (422 with the
 * errors body; its code is the first error's). Warnings ride along in {@link PdfResult#warnings()} as
 * {@code {code, message, field?}} after the program's (the PDF routes send none of them). A validator may also
 * throw {@code HookRefusedException} to refuse at once with another kind (403, 409); anything else it throws fails the
 * request (500): a PDF the policy could not judge does not leave.
 */
@FunctionalInterface
public interface PdfResultValidator {

    /** What the validator finds; {@link HookFindings#NONE} to let the PDF go. */
    HookFindings validate(PdfResultCandidate candidate);
}
