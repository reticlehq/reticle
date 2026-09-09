/**
 * `Array.prototype.at` (ES2022) ships verbatim in an ES2017 dist and throws on engines that
 * predate it — the same runtime-API gap issue #680 fixed for parse-time syntax. Source and test
 * files share this package's tsconfig, so the ES2017 `lib` pin flags any `.at()` call at
 * compile time; this helper is the replacement test code reaches for.
 */
export function at<T>(arr: readonly T[] | undefined, index: number): T | undefined {
  if (undefined === arr) return undefined;
  const resolved = index < 0 ? arr.length + index : index;
  return arr[resolved];
}
