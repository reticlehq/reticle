import { type ReticleEvent } from '@reticlehq/core'; //Bring me the event definitions from Reticle's core package
import { str } from './predicate-eval.js';

export interface RouteEventReading {
  //blueprint of how my RouteEventReading would look like
  routePath: string;
  docPath: string;
  hash: string;
  search: string;
  full: string;
}
//Create a function called routeOfEvent. It accepts one route-change event as input,
// and it will return route information in the form of routePath, docPath, hash, search, and full
export function routeOfEvent(event: ReticleEvent): RouteEventReading {
  const pathname = str(event.data['pathname']) ?? str(event.data['to']) ?? '';
  const search = str(event.data['search']) ?? '';
  const hash = str(event.data['hash']) ?? '';

  const docPath = pathname;
  const routePath = hash.startsWith('#/') ? hash.slice(1) : pathname;
  const full = `${docPath}${search}${hash}`;

  return {
    routePath,
    docPath,
    hash,
    search,
    full,
  };
}
