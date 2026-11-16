/** The text of a thrown value: an `Error`'s message, else the value itself as a string. */
export function errorText(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
