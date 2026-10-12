import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, CredentialRefusedError } from './cloud-kit.js';

/*
 * A contributor's `reticle connect --project <new>` is refused 403 because creating a project needs
 * a maintainer. That is a permission, not a refused credential: it was printed as "the platform
 * refused your sign-in … Run `reticle login`", which sends the person to sign in again for nothing.
 */
const answer = (status: number, body: unknown): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status, statusText: 'Forbidden' })),
    ),
  );
};

describe('a 403 the platform explains', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is printed in the platform words, not as a refused sign-in', async () => {
    const said =
      'Only a maintainer, an admin or the owner of this workspace can create a project. Ask one to create it on the dashboard (or run reticle connect), then connect to it.';
    answer(403, { error: { code: 'forbidden', message: said } });
    const error = await api('POST', 'https://cloud.test/v1/projects', 'tok', { name: 'x' }).catch(
      (e: unknown) => e,
    );
    expect(error).not.toBeInstanceOf(CredentialRefusedError);
    expect((error as Error).message).toBe(said);
  });

  it('still reads a refused credential as one', async () => {
    answer(401, { error: { code: 'unauthorized', message: 'sign in or API key required' } });
    const error = await api('GET', 'https://cloud.test/v1/me', 'tok').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CredentialRefusedError);
  });
});
