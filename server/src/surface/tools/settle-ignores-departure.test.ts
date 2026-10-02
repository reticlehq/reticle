/**
 * A departure is not an outstanding request, and counting it as one would wedge the settle oracle.
 *
 * `NetInitiator.NAVIGATION` records where the browser was SENT — an OAuth handoff, a native download
 * — as an unmatched `NET_PENDING`, because the response is delivered to a document this session does
 * not live into. That is honest, and it is also permanent: no `NET_REQUEST` can ever match it.
 *
 * The settle oracle reads unmatched pendings as "still in flight". Left unguarded, the first click
 * on any outbound link or download button would make that page read as never settling, for the rest
 * of the session — trading an unprovable OAuth handoff for a broken settle on every page that has a
 * link. This is the guard for that, and it is the reason the exclusion exists at all.
 */
import { describe, expect, it } from 'vitest';
import { EventType, NetInitiator } from '@reticlehq/core';
import { inFlightRequestIds, inFlightRequestLabels } from './act/settle-in-flight.js';

const pending = (
  id: string,
  url: string,
  initiator: string,
): { type: string; data: Record<string, unknown> } => ({
  type: EventType.NET_PENDING,
  data: { id, url, method: 'GET', initiator },
});

const completed = (id: string): { type: string; data: Record<string, unknown> } => ({
  type: EventType.NET_REQUEST,
  data: { id, url: 'http://app.test/api/x', status: 200 },
});

const DEPARTURE = pending('nav-1', 'https://accounts.google.com/o/oauth2', NetInitiator.NAVIGATION);
const REAL = pending('r-1', 'http://app.test/api/save', NetInitiator.FETCH);

describe('the settle oracle ignores a departure', () => {
  it('does not count it as outstanding', () => {
    expect(
      inFlightRequestIds([DEPARTURE]),
      'it can never be matched, so counting it means this page never settles again',
    ).toEqual([]);
  });

  it('does not name it among the requests an unsettled verdict reports', () => {
    expect(inFlightRequestLabels([DEPARTURE])).toEqual([]);
  });

  it('still counts a real request that has not completed', () => {
    expect(inFlightRequestIds([REAL])).toEqual(['r-1']);
  });

  it('counts the real one and ignores the departure when both are present', () => {
    expect(inFlightRequestIds([DEPARTURE, REAL])).toEqual(['r-1']);
    expect(inFlightRequestLabels([DEPARTURE, REAL])).toEqual(['GET http://app.test/api/save']);
  });

  it('still settles a real request once its completion arrives', () => {
    expect(inFlightRequestIds([DEPARTURE, REAL, completed('r-1')])).toEqual([]);
  });
});
