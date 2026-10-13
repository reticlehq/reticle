/**
 * The credentials a persona names, taken out of it before it leaves this machine.
 *
 * A persona that said "sign in as ana@acme.test, password: hunter2" was driven with the platform's
 * default address and a 401, so every journey behind a login failed; and the persona travelled
 * verbatim, so the password was stored in the synced run. The values become secret fields this
 * machine fills (the platform types a placeholder for a field it knows only by name, see
 * `server-driver.ts`), the password is redacted from the text, and the persona's own values win over
 * a `RETICLE_SECRET_*` set in the environment, which wins over the platform's default.
 */

/** The prefix a secret field's variable carries; the server driver reads the same. */
const SECRET_ENV_PREFIX = 'RETICLE_SECRET_';

/**
 * The field names an email is offered under, as the platform derives them from a label.
 * ponytail: the common sign-in labels only; a form labelled otherwise gets the platform's default.
 */
const EMAIL_FIELDS = ['EMAIL', 'EMAIL_ADDRESS', 'WORK_EMAIL', 'YOUR_EMAIL'] as const;
const PASSWORD_FIELDS = [
  'PASSWORD',
  'CURRENT_PASSWORD',
  'NEW_PASSWORD',
  'CREATE_A_PASSWORD',
  'CHOOSE_A_PASSWORD',
  'CONFIRM_PASSWORD',
] as const;

/**
 * The person a persona is, when it opens with their name: "Nina Patel, who …". A sign-up form asks
 * for it, and the Harness typed "reticle harness" into First name. Only a leading name followed by a
 * comma counts; "an admin who …" names nobody and fills nothing.
 */
const NAME = /^\s*(\p{Lu}\p{Ll}+)(?:\s+(\p{Lu}\p{Ll}+))?\s*,/u;

/** What stands in for a password in the text that is sent and stored. */
export const REDACTED_SECRET = '[redacted]';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
/**
 * "password: x", "password is x", "password = x", a quoted value right after the word, or an
 * unquoted one with a digit in it ("password Nina-pass-12345!"): a word with no digit after
 * "password" is prose ("reset the password from the menu"), never a value.
 */
/**
 * An unquoted value stops at a closing bracket, and a sentence's full stop is not part of it:
 * "(password: x!)" typed "x!)" and every sign-in was refused.
 */
const PASSWORD =
  /\bpass(?:word|code)\b(?:\s*(?::|=|\bis\b)\s*(?:"([^"\n]+)"|“([^”\n]+)”|([^\s"“,;()]+?)(?=\.?(?:\s|$|[,;)])))|\s+(?:"([^"\n]+)"|“([^”\n]+)”)|\s+([^\s"“,;()]*\d[^\s"“,;()]*?)(?=\.?(?:\s|$|[,;)])))/i;

export interface PersonaCredentials {
  /** The persona with its password redacted: what may be sent to the platform and stored. */
  persona: string;
  /** Secret-field variables the drive fills from, persona values only. */
  secrets: Record<string, string>;
}

/** Take the email and password a persona names out of it. */
export function personaCredentials(persona: string): PersonaCredentials {
  const secrets: Record<string, string> = {};
  const name = NAME.exec(persona);
  if (name?.[1] !== undefined) {
    const full = name[2] === undefined ? name[1] : `${name[1]} ${name[2]}`;
    secrets[`${SECRET_ENV_PREFIX}FIRST_NAME`] = name[1];
    secrets[`${SECRET_ENV_PREFIX}FULL_NAME`] = full;
    secrets[`${SECRET_ENV_PREFIX}NAME`] = full;
    if (name[2] !== undefined) secrets[`${SECRET_ENV_PREFIX}LAST_NAME`] = name[2];
  }
  const email = EMAIL.exec(persona)?.[0];
  if (email !== undefined)
    for (const field of EMAIL_FIELDS) secrets[`${SECRET_ENV_PREFIX}${field}`] = email;
  const match = PASSWORD.exec(persona);
  const password = match?.slice(1).find((group) => group !== undefined);
  if (null === match || password === undefined) return { persona, secrets };
  for (const field of PASSWORD_FIELDS) secrets[`${SECRET_ENV_PREFIX}${field}`] = password;
  const redacted = match[0].replace(password, REDACTED_SECRET);
  return { persona: persona.replace(match[0], redacted), secrets };
}
