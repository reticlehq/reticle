/**
 * Where a page runs and what a drive may do there, as a HELLO announces it.
 *
 * A leaf on purpose: the browser SDK sends these two words, and nothing else about production mode
 * belongs in a page's first load. The policy that reads them lives in `production-policy.ts`.
 */

/** The environment a page says it runs in. Absent means `development`, which is every older SDK. */
export const HelloEnv = {
  DEVELOPMENT: 'development',
  PRODUCTION: 'production',
} as const;
export type HelloEnv = (typeof HelloEnv)[keyof typeof HelloEnv];

/**
 * What a drive may do on the page. `observe` reads only. `act` also clicks and types.
 * Absent means `act` in development. A production HELLO must say which.
 */
export const HelloScope = {
  OBSERVE: 'observe',
  ACT: 'act',
} as const;
export type HelloScope = (typeof HelloScope)[keyof typeof HelloScope];
