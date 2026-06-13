export interface SourceLocation {
  file: string;
  line: number;
  column?: number;
}

export interface ComponentInfo {
  /** Component display names from the rendered element up to the root. */
  componentStack: string[];
  /** Best-effort source location of the nearest component (plan/07). */
  source?: SourceLocation;
}

/**
 * Resolve the React component identity + source file for a DOM node by walking the
 * fiber tree (`__reactFiber$*` -> `return` chain). M3 implements the real walk; this is
 * the adapter contract from plan/07-framework-adapters.md.
 */
export function identify(node: Element): ComponentInfo | null {
  // TODO(M3): read the fiber key off `node`, walk `.return`, collect displayNames,
  // and pull source from `_debugSource` / the data-iris-source attribute.
  void node;
  return null;
}
