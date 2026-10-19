import { EventType, MediaEvent } from '@reticlehq/core';
import { refs } from '@/dom/addressing/refs.js';
import { observeSafely, type Emit, type Teardown } from './types.js';

/**
 * `<video>` and `<audio>` playback, as `MEDIA_STATE` events.
 *
 * A media app's defect is often an ORDERING: "Ready" shown before the response arrived, a video
 * that started before its source loaded. The DOM never says when playback started or where it was,
 * so a recording had the network's times and nothing to order them against. Media events do not
 * bubble, so they are heard in the capture phase on the document. `timeupdate` is left out: it
 * fires several times a second.
 */
const TAGS: Readonly<Record<string, 'video' | 'audio'>> = { VIDEO: 'video', AUDIO: 'audio' };

export function installMedia(emit: Emit): Teardown {
  const ac = new AbortController();
  const onMedia = (event: Event): void => {
    observeSafely(() => {
      const el = event.target;
      if (!(el instanceof HTMLMediaElement)) return;
      const tag = TAGS[el.tagName];
      if (tag === undefined) return;
      const duration = Number.isFinite(el.duration) ? el.duration : undefined;
      emit(
        EventType.MEDIA_STATE,
        {
          event: event.type,
          tag,
          currentTime: el.currentTime,
          ...(duration === undefined ? {} : { duration }),
          readyState: el.readyState,
          paused: el.paused,
        },
        refs.refFor(el),
      );
    });
  };
  for (const type of Object.values(MediaEvent)) {
    document.addEventListener(type, onMedia, { capture: true, signal: ac.signal });
  }
  return () => ac.abort();
}
