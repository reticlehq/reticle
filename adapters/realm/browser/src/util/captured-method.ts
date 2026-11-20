/**
 * Read a host object's method as a STORED VALUE, for code that has to put it back.
 *
 * Every observer here patches a global and must be able to undo it: `console.error`, `window.fetch`,
 * `window.setTimeout`, `Date.now`. Undoing means holding the true original — the same function
 * object, so teardown restores exactly what was there and a later install can recognise it by
 * identity — and calling through a separately bound copy, because a host method invoked with the
 * wrong receiver throws (`fetch` gives "Illegal invocation").
 *
 * Written as `const original = window.fetch`, that is a bare unbound method reference, and
 * `@typescript-eslint/unbound-method` is right to flag the SHAPE even though this use is deliberate:
 * the rule cannot see that the next line binds it, nor that the raw value only ever goes back into
 * the slot it came from.
 *
 * The two obvious ways out are both wrong here. An `eslint-disable` is against this repo's standing
 * rule and hides the shape from every future reader. Annotating `this: void` asserts the function
 * does not use its receiver — which for a console method or `fetch` is simply false, and is the very
 * reason the binding exists.
 *
 * So the intent is expressed instead of suppressed. A property descriptor's `value` is a stored
 * value, not a method being detached from its object, which is exactly the distinction the rule is
 * drawing and exactly what this code wants. It is also strictly more accurate for the restore case:
 * it reads what the slot HOLDS rather than what calling the property would do, so an accessor
 * defined on the object cannot be silently flattened into its result.
 *
 * Returns undefined when the property is absent or inherited rather than own — a caller that needs a
 * fallback to the prototype chain should say so at its own call site rather than have it hidden here.
 */
export function capturedMethod<T>(target: object, key: PropertyKey): T | undefined {
  return Object.getOwnPropertyDescriptor(target, key)?.value as T | undefined;
}

/**
 * The same, for a property this code knows is present — the globals every observer patches.
 *
 * Throws rather than returning a broken teardown. A missing `window.fetch` is not a condition any
 * caller here can recover from, and silently installing a patch that cannot be undone is worse than
 * refusing: the page keeps the wrapper for the rest of its life with nothing able to remove it.
 */
export function requireCapturedMethod<T>(target: object, key: PropertyKey): T {
  const value = capturedMethod<T>(target, key);
  if (value === undefined) {
    throw new Error(
      `[Reticle] cannot patch ${String(key)}: it is not an own property of the target`,
    );
  }
  return value;
}
