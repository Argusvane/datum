/**
 * The host's half of verifying a PDF (PDF ABI 3.14): signature values checked with
 * {@code java.security}, signers placed by fingerprint, anchor or self-signature, timestamp tokens checked whole with
 * datum-timestamp's {@code TimestampToken.verifyOver}, certifications judged against what later revisions changed.
 */
package com.argusvane.datum.pdf.verify;
