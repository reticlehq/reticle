import { describe, expect, it } from 'vitest';
import { Surface, SurfaceSchema } from './subject.js';

/**
 * A surface this specification does not name must be namespaced, the way a channel is.
 *
 * `ChannelIdSchema` accepts `nativeEnum | /^x-[a-z0-9-]+$/`: an extension is visibly an
 * extension, and cannot collide with a value the specification names later. `SurfaceSchema`
 * accepted `z.string().min(1)` — extensible, and NOT namespaced. The two sat three files apart
 * and disagreed about the same question.
 *
 * That asymmetry has a cost with a date on it. Somebody verifying a voice agent today writes
 * `surface: 'voice'`, because no named value fits and a bare string is allowed. If this
 * specification later names `voice` with a definition of its own, every artifact already
 * written silently means something else — no validator rejects it, no version distinguishes
 * it, and the artifact was the durable thing. `x-voice` cannot collide, and says on its face
 * that it is somebody's extension rather than this document's word.
 *
 * The fix is a narrowing, and now is the only cheap moment: the protocol is unpublished, so
 * nothing in the world is written the old way yet.
 *
 * Deliberately NOT fixed by adding `voice`, `robot`, `lab` and `agent` to the enum. That is how
 * a generic contract turns into a list of the domains its author happened to think of, and
 * SPEC.md now says so about predicates in the same words.
 */
describe('an unnamed surface is namespaced, exactly as an unnamed channel is', () => {
  it('accepts every surface the specification names', () => {
    for (const surface of Object.values(Surface)) {
      expect(SurfaceSchema.safeParse(surface).success, surface).toBe(true);
    }
  });

  it('accepts an x- extension, so a domain this document never imagined can be named', () => {
    for (const s of ['x-voice', 'x-genai-agent', 'x-lab-instrument', 'x-smart-home-hub']) {
      expect(SurfaceSchema.safeParse(s).success, s).toBe(true);
    }
  });

  it('refuses a bare unnamespaced string, which could collide with a future named value', () => {
    for (const s of ['voice', 'robot', 'Voice', 'x_voice', 'x-', '']) {
      expect(SurfaceSchema.safeParse(s).success, s).toBe(false);
    }
  });
});
