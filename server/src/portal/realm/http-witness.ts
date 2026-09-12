/**
 * The reference witness: a second vantage point that can look and cannot touch.
 *
 * Every channel a `Realm` declares is, in the end, the subject describing itself — the DOM says the
 * DOM changed, the store says the store changed. That is enough for most questions and useless for
 * the one that matters most: *did the thing the app claims to have done actually happen out in the
 * world?* Clicking "Delete account" changes the screen AND drops a row, sends an email, revokes a
 * session in another tab. Every one of those is invisible to an in-subject observer, and every one
 * of them is where the expensive bugs live.
 *
 * This reads a real HTTP endpoint over the real network, in a different process from the page. No
 * fixture, no recorded response, no stub in the product path: a witness consulting a canned answer
 * is the subject describing itself with extra steps, and the evidence would be worth nothing.
 *
 * `openreality` ships the abstraction and requires it be proved twice. This is the second proof.
 */

import {
  BlindSpotKind,
  CHANNEL_DEFAULTS,
  ChannelId,
  CloseCondition,
  Grade,
  Independence,
  Surface,
  Witness,
  type ChannelDescriptor,
  type Coverage,
  type Observation,
  type SubjectRef,
  type Window,
} from '@reticlehq/openreality';

/** Everything it needs from outside itself — no globals, no ambient clock. */
export interface HttpWitnessInput {
  /** What to ask. A read-only endpoint: a witness that mutated would stop being one. */
  url: string;
  fetch: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  now: () => number;
}

/** How much of a response body to carry into a verdict. The rest is one fetch away. */
const SUMMARY_CAP = 200;

export class HttpWitness extends Witness {
  readonly #url: string;
  readonly #fetch: HttpWitnessInput['fetch'];
  readonly #now: () => number;
  /**
   * One look per window, shared by `observe` and `coverage`.
   *
   * Memoised rather than re-fetched because they are two questions about ONE observation: what did
   * you see, and what could you not see. Asking twice could answer them about different moments,
   * and a coverage claim that describes a different instant from the evidence is worse than none.
   * It also makes the pair order-independent — `coverage` used to depend on `observe` having run
   * first, which is hidden state, and a caller that asked in the other order was told the witness
   * saw everything when it had not looked at all.
   */
  readonly #looks = new Map<string, Promise<{ body: string; status: number; failure?: string }>>();

  constructor(input: HttpWitnessInput) {
    super();
    this.#url = input.url;
    this.#fetch = input.fetch;
    this.#now = input.now;
  }

  identity(): SubjectRef {
    return { surface: Surface.SERVICE, instance: this.#url, epoch: 1 };
  }

  /**
   * `net`, and INDEPENDENT — which is the entire reason asking is worth anything.
   *
   * The page's own network channel is actuation-derived: it reports the requests the page made. This
   * one is the answer read back from outside the page, so it can contradict the app rather than
   * echo it, and it is graded at `consequence` for exactly that reason.
   */
  channels(): readonly ChannelDescriptor[] {
    return [
      {
        id: ChannelId.NET,
        ...CHANNEL_DEFAULTS[ChannelId.NET],
        independence: Independence.INDEPENDENT,
        grade: Grade.CONSEQUENCE,
      },
    ];
  }

  openWindow(budgetMs: number): Window {
    return {
      id: `hw-${String(this.#now())}`,
      openedAt: this.#now(),
      budgetMs,
      closes: CloseCondition.BUDGET_EXHAUSTED,
      subject: this.identity(),
    };
  }

  /**
   * Look once, at close.
   *
   * A failed look returns NOTHING and records why. It must never be reported as "observed nothing":
   * `witnessDisagreement` reads an empty `observed` with no blind spot as *the witness looked and
   * the world disagreed with the app*, which would turn this witness's own network error into an
   * accusation against somebody else's code.
   */
  #look(window: Window): Promise<{ body: string; status: number; failure?: string }> {
    const cached = this.#looks.get(window.id);
    if (cached !== undefined) return cached;
    const pending = (async (): Promise<{ body: string; status: number; failure?: string }> => {
      try {
        const res = await this.#fetch(this.#url);
        return { body: await res.text(), status: res.status };
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        return { body: '', status: 0, failure };
      }
    })();
    this.#looks.set(window.id, pending);
    return pending;
  }

  async observe(window: Window): Promise<readonly Observation[]> {
    const seen = await this.#look(window);
    if (seen.failure !== undefined || 0 === seen.body.length) return [];
    return [
      {
        id: `${window.id}-0`,
        window: window.id,
        channel: ChannelId.NET,
        at: this.#now(),
        value: seen.body,
        summary: `${String(seen.status)} from ${this.#url}: ${seen.body.slice(0, SUMMARY_CAP)}`,
      },
    ];
  }

  /**
   * An empty `blindSpots` is a POSITIVE claim that nothing was hidden, so it is only ever returned
   * after a look that actually completed.
   */
  async coverage(window: Window): Promise<Coverage> {
    const failure = (await this.#look(window)).failure;
    if (failure === undefined) {
      return { window: window.id, observed: [ChannelId.NET], blindSpots: [] };
    }
    return {
      window: window.id,
      observed: [],
      blindSpots: [
        {
          kind: BlindSpotKind.BOUNDARY_UNCROSSABLE,
          channel: ChannelId.NET,
          detail: `could not reach ${this.#url}: ${failure}`,
          // A witness that could not look impeaches every claim it was asked to corroborate — the
          // verdict must read `unknown`, never a pass earned by an observer that was not there.
          impeaching: true,
          remedy: 'check the endpoint is running and reachable from the daemon',
        },
      ],
    };
  }
}
