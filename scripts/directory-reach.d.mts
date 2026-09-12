// Types for directory-reach.mjs, so the guards that import it stay typed.
export function sourceFiles(packageDir: string): string[];
export function directories(packageDir: string): string[];
export function nameCollisions(packageDir: string): string[];
export function reaches(packageDir: string): Map<string, Set<string>>;
export function mutualPairs(packageDir: string): string[];
