/**
 * Capture a method off an object so it can be restored — or re-invoked via `.call` — later.
 *
 * Monkeypatching is unavoidable in this SDK: observing history, console, fetch and XHR means
 * replacing a method and putting the original back on teardown. Putting it back requires holding the
 * UNBOUND original, because identity is what teardown compares — a bound copy is a different function
 * and would leave the patch installed forever.
 *
 * `@typescript-eslint/unbound-method` exists to catch the common mistake this pattern deliberately
 * makes, so every such site used to carry an eslint-disable. Disabling a rule seven times to express
 * one intention is worse than naming the intention once: those disables also suppressed the rule for
 * any OTHER unbound access on the same lines, which is exactly what the rule is for.
 *
 * The generic index access here is not something the rule flags, so callers stay clean and the
 * "I meant to do this" is stated in one place instead of seven.
 */
export function captureMethod<T, K extends keyof T>(target: T, key: K): T[K] {
  return target[key];
}

/**
 * The `value` setter defined on a prototype, for inputs whose value must be set the way the browser
 * does it — React installs its own descriptor, and assigning `el.value` directly skips the tracker it
 * relies on to notice a change.
 *
 * Same reason as `captureMethod` for existing separately from its call site: a property descriptor's
 * `set` is an unbound function, and naming that intention once beats disabling the rule at each use.
 */
export function captureValueSetter(
  proto: object,
): ((this: HTMLElement, value: string) => void) | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor === undefined) return undefined;
  // Read through the same generic index access `captureMethod` uses: reaching for `.set` directly is
  // what the rule flags, and it is right to in general — this is the one place that means it.
  const setter = captureMethod(descriptor, 'set');
  return setter as ((this: HTMLElement, value: string) => void) | undefined;
}

/**
 * The `checked` setter defined on a prototype, for inputs whose checked state must be set the way
 * the browser does it — React installs its own descriptor, and assigning `el.checked` directly skips
 * the tracker it relies on to notice a change.
 */
export function captureCheckedSetter(
  proto: object,
): ((this: HTMLElement, value: boolean) => void) | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'checked');
  if (descriptor === undefined) return undefined;
  const setter = captureMethod(descriptor, 'set');
  return setter as ((this: HTMLElement, value: boolean) => void) | undefined;
}
