/**
 * The flag that accepts the certificate.
 *
 * Defined here rather than in the CLI grammar because the browser driver needs the exact spelling
 * too: a navigation the certificate stopped names this flag, and a message that named a flag nobody
 * parses would be worse than no message (#1713). The grammar re-exports it, so every command's
 * parser still reads its flags from one module, and `portal/input` does not have to reach into
 * `command/cli` for a string.
 */
export const IGNORE_HTTPS_ERRORS_FLAG = '--ignore-https-errors';

/**
 * Chromium's certificate failures, as Playwright words them.
 *
 * `net::ERR_CERT_AUTHORITY_INVALID`, `net::ERR_CERT_DATE_INVALID`,
 * `net::ERR_CERT_COMMON_NAME_INVALID` and the rest of the family. A self-signed or mkcert dev
 * certificate on localhost is the ordinary cause, not a broken app.
 *
 * Unanchored because one caller reads a cleaned net code and the other reads Playwright's whole
 * `page.goto: ... at <url>` sentence.
 */
const CERTIFICATE_ERROR = /net::ERR_CERT_/;

/** True when a navigation failure was the TLS certificate, not the app behind it. */
export function isCertificateError(message: string): boolean {
  return CERTIFICATE_ERROR.test(message);
}
