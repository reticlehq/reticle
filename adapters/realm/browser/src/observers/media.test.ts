/**
 * Media playback, in order with everything else.
 *
 * A video app's defect is often an ordering ("Ready" shown before the response arrived). The DOM
 * never says when a video started playing or where it was, so a recording of such an app had the
 * network's times and nothing to order them against.
 */
import { describe, expect, it } from 'vitest';
import { EventType, MediaEvent } from '@reticlehq/core';
import { installMedia } from './media.js';

describe('the media observer', () => {
  it('reports play, seek and end with the element state, for video and audio', () => {
    document.body.innerHTML = '<video></video><audio></audio>';
    const events: { type: EventType; data: Record<string, unknown> }[] = [];
    const teardown = installMedia((type, data) => events.push({ type, data }));
    const video = document.querySelector('video') as HTMLVideoElement;
    video.dispatchEvent(new Event(MediaEvent.PLAY));
    video.dispatchEvent(new Event(MediaEvent.SEEKED));
    (document.querySelector('audio') as HTMLAudioElement).dispatchEvent(
      new Event(MediaEvent.ENDED),
    );
    // Not reported: fires several times a second while playing.
    video.dispatchEvent(new Event('timeupdate'));
    teardown();
    video.dispatchEvent(new Event(MediaEvent.PAUSE));
    expect(events.map((e) => [e.type, e.data['event'], e.data['tag']])).toEqual([
      [EventType.MEDIA_STATE, MediaEvent.PLAY, 'video'],
      [EventType.MEDIA_STATE, MediaEvent.SEEKED, 'video'],
      [EventType.MEDIA_STATE, MediaEvent.ENDED, 'audio'],
    ]);
    expect(events[0]?.data).toMatchObject({ currentTime: 0, readyState: 0, paused: true });
  });
});
