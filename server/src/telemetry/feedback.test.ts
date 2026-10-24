import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FEEDBACK_TEXT_MAX,
  StackUnknownReason,
  isFeedbackContact,
  type Feedback,
} from '@reticlehq/core/telemetry';
import * as telemetryModule from './telemetry.js';
import {
  FEEDBACK_ENV,
  REDACTED,
  feedbackDisabled,
  redactFeedbackText,
  submitFeedback,
  summarizeTrace,
} from './feedback.js';
import { detectMcpScope, detectStack } from './feedback-context.js';

/**
 * The redaction tests are the privacy contract, written as examples of what must never reach the
 * wire. Feedback is the only free text Reticle sends, so each case here is a leak that would
 * otherwise be real: someone pastes a failing fetch, and the Authorization header rides along.
 */
describe('redactFeedbackText', () => {
  it('strips an email address', () => {
    const out = redactFeedbackText('login failed for ada@example.com on submit', FEEDBACK_TEXT_MAX);
    expect(out.text).not.toContain('ada@example.com');
    expect(out.text).toContain(REDACTED);
    expect(out.removed).toContain('email');
  });

  it('strips credentials inline in a URL but keeps the scheme, so the trace still reads', () => {
    const out = redactFeedbackText(
      'called https://admin:hunter2@api.internal/v1',
      FEEDBACK_TEXT_MAX,
    );
    expect(out.text).not.toContain('hunter2');
    expect(out.text).toContain('https://');
    expect(out.removed).toContain('url-credentials');
  });

  it('strips a credential VALUE and keeps its key — the key is the useful half', () => {
    const out = redactFeedbackText('header authorization: Bearer abc123XYZ', FEEDBACK_TEXT_MAX);
    expect(out.text).not.toContain('abc123XYZ');
    expect(out.text.toLowerCase()).toContain('authorization');
  });

  it.each([
    ['sk-abcdefghijklmnopqrstuvwx', 'vendor-key'],
    ['ghp_abcdefghijklmnopqrstuvwxyz1234', 'github-token'],
    ['AKIAIOSFODNN7EXAMPLE', 'aws-key'],
    ['xoxb-1234567890-abcdefghij', 'slack-token'],
  ])('strips the self-identifying token %s', (secret, label) => {
    const out = redactFeedbackText(`the request used ${secret} and failed`, FEEDBACK_TEXT_MAX);
    expect(out.text).not.toContain(secret);
    expect(out.removed).toContain(label);
  });

  /**
   * Each of these left the redactor unchanged, and the prompt hook uses this redactor for every
   * prompt it keeps. The keys are built at run time, so no scanner reads them as real secrets.
   */
  const fake = (...parts: string[]): string => parts.join('');
  it.each([
    [
      'a bare Stripe live key',
      `use ${fake('sk', '_live_', '51HxQ', 'a'.repeat(20))} for it`,
      'sk_live',
    ],
    ['a bare Stripe test key', `use ${fake('sk', '_test_', 'b'.repeat(24))} here`, 'sk_test'],
    [
      'an env Stripe key',
      `STRIPE_SECRET_KEY=${fake('sk', '_live_', 'c'.repeat(24))}`,
      'c'.repeat(24),
    ],
    [
      'an env AWS secret key',
      `AWS_SECRET_ACCESS_KEY=${fake('wJalrXUtnFEMI', '/K7MDENG/', 'bPxRfiCYEXAMPLEKEY')}`,
      'wJalrXUtnFEMI',
    ],
    ['an AWS access key id', `key ${fake('AKIA', 'Z'.repeat(16))} here`, 'AKIA'],
    ['a Google API key', `maps ${fake('AIza', 'S'.repeat(35))} key`, 'AIza'],
    ['a GitLab token', `push ${fake('glpat', '-', 'g'.repeat(20))} now`, 'glpat'],
    ['a GitHub classic token', `gh ${fake('ghp', '_', 'h'.repeat(36))}`, 'ghp_'],
    ['a GitHub fine-grained token', `gh ${fake('github', '_pat_', 'p'.repeat(40))}`, 'github_pat'],
    ['a Slack bot token', `slack ${fake('xox', 'b-', '1234567890-', 'q'.repeat(12))}`, 'xoxb'],
    ['a Slack user token', `slack ${fake('xox', 'p-', '1234567890-', 'r'.repeat(12))}`, 'xoxp'],
    ['a DB password in env style', 'DB_PASS: Tr0ub4dor&3', 'Tr0ub4dor'],
    ['a token in env style', 'GITHUB_TOKEN=abc123def456', 'abc123def456'],
    ['a password in a sentence', 'my password is hunter2', 'hunter2'],
    ['a card number', 'charge 4242 4242 4242 4242 today', '4242 4242'],
    ['a card number with no spaces', 'card 4111111111111111 failed', '4111111111111111'],
    ['an international phone number', 'call +44 20 7946 0958 later', '7946'],
    ['a US phone number', 'call (415) 555-0100 later', '555-0100'],
  ])('strips %s', (_label, input, leak) => {
    const out = redactFeedbackText(input, FEEDBACK_TEXT_MAX);
    expect(out.text, out.text).not.toContain(leak);
    expect(out.text).toContain(REDACTED);
  });

  it('hides the password and keeps the sentence readable', () => {
    expect(redactFeedbackText('my password is hunter2', FEEDBACK_TEXT_MAX).text).toBe(
      `my password${REDACTED}`,
    );
  });

  it.each([
    ['a numeric id that fails the card check', 'order 4242424242424241 shipped'],
    ['a millisecond timestamp', 'at 1729300000000 it failed'],
    ['a name that only contains a sensitive word', 'PASSPORT_ID=12 and TOKENIZER_MODE=fast'],
    ['a short number with a plus', 'count went +12 after the click'],
  ])('keeps %s', (_label, input) => {
    expect(redactFeedbackText(input, FEEDBACK_TEXT_MAX).text).toBe(input);
  });

  it('strips a home directory path — it carries the account name', () => {
    const out = redactFeedbackText('stack at /Users/ada/projects/app.tsx:10', FEEDBACK_TEXT_MAX);
    expect(out.text).not.toContain('/Users/ada');
    expect(out.removed).toContain('home-path');
  });

  /**
   * A home path keeps the account name in no spelling. An agent that pastes a JSON string doubles
   * each backslash, and JSON can also escape a forward slash. Each row must lose the name.
   */
  it.each([
    ['a Windows home', String.raw`open C:\Users\someone\app\x.ts`],
    ['a JSON-escaped Windows home', String.raw`{"path":"C:\\Users\\someone\\app"}`],
    ['a JSON-escaped Windows home in prose', String.raw`open C:\\Users\\someone\\app now`],
    ['a forward-slash Windows home', 'open C:/Users/someone/app/x.ts'],
    ['a lowercase-drive Windows home', String.raw`open c:\users\someone\app`],
    ['a lowercase JSON-escaped Windows home', String.raw`open c:\\users\\someone`],
    ['a JSON-escaped forward-slash Windows home', String.raw`open C:\/Users\/someone\/app`],
    ['a macOS home', 'open /Users/someone/app/x.ts'],
    ['a JSON-escaped macOS home', String.raw`{"path":"\/Users\/someone\/app"}`],
    ['a Linux home', 'open /home/someone/app/x.ts'],
    ['a JSON-escaped Linux home', String.raw`open \/home\/someone\/app`],
  ])('removes the account name from %s', (_label, input) => {
    const out = redactFeedbackText(input, FEEDBACK_TEXT_MAX);
    expect(out.text, out.text).not.toContain('someone');
    expect(out.removed).toContain('home-path');
  });

  it('leaves an ordinary report untouched and reports nothing removed', () => {
    const clean = 'reticle_act clicked the button but no click event was observed';
    const out = redactFeedbackText(clean, FEEDBACK_TEXT_MAX);
    expect(out.text).toBe(clean);
    expect(out.removed).toEqual([]);
  });

  /**
   * Each of these walked through the old rules: the home-path rule stopped at a space, so a
   * Windows surname survived; nothing covered a path outside home, a hostname, or a URL's query.
   */
  it.each([
    ['a Windows home with a space', 'failed at C:\\Users\\Jane Doe\\code\\app.ts', ['Jane', 'Doe']],
    ['a forward-slash Windows home', 'see C:/Users/jdoe/code/app.ts', ['jdoe']],
    ['a long-path Windows home', 'open \\\\?\\C:\\Users\\jdoe\\x.ts', ['jdoe']],
    ['a macOS home with a space', 'at "/Users/Jane Doe/app/x.ts" line 3', ['Jane', 'Doe']],
    ['an absolute path outside home', 'read /srv/acme-billing/config.yml', ['acme-billing']],
    ['a home-relative path', 'read ~/clients/acme/notes.txt', ['acme']],
    ['an internal hostname', 'getaddrinfo ENOTFOUND db.internal.acmecorp.com', ['acmecorp']],
    [
      'a staging host in a URL',
      'open https://staging.acme.io/orders/991?token=x#frag',
      ['acme', '991', 'token'],
    ],
    [
      'a localhost URL query',
      'GET http://localhost:3000/search?q=jane.doe@x.com&id=7',
      ['q=', 'id=7', 'jane'],
    ],
    ['a private IP', 'connect ECONNREFUSED 10.20.30.40:5432', ['10.20.30.40']],
  ])('redacts %s', (_label, input, leaks) => {
    const out = redactFeedbackText(input, FEEDBACK_TEXT_MAX);
    for (const leak of leaks) expect(out.text, out.text).not.toContain(leak);
  });

  it('keeps what makes a report readable: the local app, file names, versions', () => {
    const out = redactFeedbackText(
      'on http://localhost:5173/checkout the vite.config.ts change broke invoke-tool.ts',
      FEEDBACK_TEXT_MAX,
    );
    expect(out.text).toContain('http://localhost:5173/checkout');
    expect(out.text).toContain('vite.config.ts');
    expect(out.text).toContain('invoke-tool.ts');
  });

  it('caps the length so a pasted log cannot become an unbounded upload', () => {
    const out = redactFeedbackText('x'.repeat(FEEDBACK_TEXT_MAX + 500), FEEDBACK_TEXT_MAX);
    expect(out.text).toHaveLength(FEEDBACK_TEXT_MAX);
  });
});

// A report that cannot be sent is saved under the cwd. Left at the checkout, every run of this
// suite wrote its reports into the repository's own `.reticle`, which the daemon then synced.
beforeAll(() => {
  vi.spyOn(process, 'cwd').mockReturnValue(mkdtempSync(join(tmpdir(), 'feedback-cwd-')));
});
afterAll(() => {
  vi.restoreAllMocks();
});

/** Each report is written to a real temp directory: a bound for a slow disk, not a duration. */
const FEEDBACK_WRITE_TIMEOUT_MS = 30_000;

describe('feedbackDisabled', () => {
  it.each(['0', 'false', 'off', 'no'])('treats %s as off', (value) => {
    expect(feedbackDisabled({ [FEEDBACK_ENV]: value })).toBe(true);
  });

  it('is on when unset — the channel is opt-out, like the rest of telemetry', () => {
    expect(feedbackDisabled({})).toBe(false);
  });
});

describe('submitFeedback', () => {
  /**
   * Under vitest the emitter is a hard no-op (a test run is not a user), so every send here reports
   * `sent:false` with a reason. That is the assertion worth having: a disabled channel must DROP the
   * report and say so plainly, never silently pretend to have delivered it.
   */
  it('reports non-delivery instead of pretending, and still redacts + returns context', async () => {
    const receipt = await submitFeedback({
      source: 'agent',
      kind: 'bug',
      text: 'reticle_act failed; contact ada@example.com',
    });
    expect(receipt.sent).toBe(false);
    expect(receipt.reason).toBeDefined();
    expect(receipt.redacted).toContain('email');
  });

  it('never throws — a feedback send must not take down the call that reported the failure', async () => {
    await expect(submitFeedback({ source: 'agent', kind: 'gap', text: '' })).resolves.toMatchObject(
      { sent: false },
    );
  });

  it('refuses an explicit kill switch by name, so the reason is actionable', async () => {
    const receipt = await submitFeedback(
      { source: 'human', kind: 'experience', text: 'good', rating: 5 },
      { env: { [FEEDBACK_ENV]: '0' } },
    );
    expect(receipt.sent).toBe(false);
    expect(receipt.reason).toContain(FEEDBACK_ENV);
  });
});

describe('feedback context detection', () => {
  const pkg = (deps: Record<string, string>): string => JSON.stringify({ dependencies: deps });

  it('prefers the meta-framework over the view library it depends on', () => {
    // Every Next app also depends on react; reporting `react` would collapse the single most
    // important segment we have into the generic bucket.
    expect(detectStack('/p', () => pkg({ next: '15.0.0', react: '19.0.0' }))).toEqual({
      stack: 'next',
      stackMajor: 15,
      // `cwd` because the manifest was right here. `workspace` means discovery had to walk down to
      // find the app — the split that says how often our inference needs help.
      stackSource: 'cwd',
    });
    expect(detectStack('/p', () => pkg({ nuxt: '3.0.0', vue: '3.4.0' })).stack).toBe('nuxt');
  });

  it.each([
    [{ react: '^19.1.0' }, 'react', 19],
    [{ vue: '3.4.0' }, 'vue', 3],
    [{ astro: '~4.0.0' }, 'astro', 4],
    [{ 'solid-js': '1.8.0' }, 'solid', 1],
    [{ '@sveltejs/kit': '2.0.0' }, 'sveltekit', 2],
    [{ '@tanstack/react-start': '1.121.0', react: '19.0.0' }, 'tanstack-start', 1],
  ])('detects %o with its major version', (deps, stack, stackMajor) => {
    expect(detectStack('/p', () => pkg(deps))).toEqual({ stack, stackMajor, stackSource: 'cwd' });
  });

  it('reports the stack without a major when the range has no readable number', () => {
    expect(detectStack('/p', () => pkg({ react: 'workspace:*' }))).toEqual({
      stack: 'react',
      stackSource: 'cwd',
    });
  });

  it('returns nothing rather than guessing when package.json is unreadable', () => {
    // No guessed stack, as before. The miss now names itself (#617); an unreadable manifest is not
    // evidence ABOUT the app, so it reports NO_APP_FOUND rather than claiming we recognised nothing.
    const got = detectStack('/p', () => {
      throw new Error('ENOENT');
    });
    expect(got.stack).toBeUndefined();
    expect(got.stackMajor).toBeUndefined();
    expect(got.stackSource).toBeUndefined();
    expect(got.stackUnknownReason).toBe(StackUnknownReason.NO_APP_FOUND);
  });

  it('reads project scope from a checked-in MCP registration, user scope otherwise', () => {
    expect(detectMcpScope('/p', (path) => path.endsWith('.mcp.json'))).toBe('project');
    expect(detectMcpScope('/p', () => false)).toBe('user');
  });
});

/**
 * Feature requests from AGENTS.
 *
 * Reticle is built for agents, which makes the agent the user whose wishes decide the roadmap — and
 * the one user who never got asked. It would hit a limitation, work around it, finish the task, and
 * the wish would evaporate with its context window. These pin the channel that catches it.
 */
describe('agents can ask for things, not only report failures', () => {
  it('accepts a feature request with the why, the impact and the workaround', async () => {
    const receipt = await submitFeedback({
      source: 'agent',
      kind: 'feature_request',
      text: 'A way to assert that no request fired during an action.',
      need: 'Verifying a debounced search does NOT call the API on every keystroke.',
      impact: 'Removes a 3-call workaround from every debounce check.',
      currentApproach: 'Calling reticle_network before and after and diffing counts by hand.',
      model: 'claude-opus-4',
    });
    // Under vitest the emitter is a no-op, so the assertion is that it VALIDATES and is not rejected.
    expect(receipt.reason).not.toMatch(/invalid/i);
    expect(receipt.redacted).toEqual([]);
  });

  it(
    'separates a feature request from an improvement — the responses differ completely',
    async () => {
      for (const kind of ['feature_request', 'improvement'] as const) {
        const receipt = await submitFeedback({ source: 'agent', kind, text: 'x' });
        expect(receipt.reason, `kind '${kind}' was rejected`).not.toMatch(/invalid/i);
      }
    },
    FEEDBACK_WRITE_TIMEOUT_MS,
  );

  /**
   * The model cannot come from the transport: MCP's clientInfo carries a name and version and has no
   * concept of a model. Self-reporting is the only mechanism, so it must survive the pipeline.
   */
  it('carries the self-reported model, which no other channel can supply', async () => {
    const receipt = await submitFeedback({
      source: 'agent',
      kind: 'improvement',
      text: 'x',
      model: 'gpt-5',
    });
    expect(receipt.reason).not.toMatch(/invalid/i);
  });

  /**
   * A real leak, caught by writing the test properly.
   *
   * Redaction originally named `text` and `trace` explicitly, so when `need`, `impact` and
   * `currentApproach` were added they bypassed it entirely and went to the wire raw. The first
   * version of THIS test passed anyway — because it put an email in `text` and only checked that
   * something was redacted. Each field is now asserted on its own, with a secret that appears
   * nowhere else, so a bypass cannot hide behind a sibling field.
   */
  it.each([
    ['need', 'need', 'ada@example.com', 'email'],
    ['impact', 'impact', 'ada@example.com', 'email'],
    ['currentApproach', 'currentApproach', 'sk-abcdefghijklmnopqrstuvwx', 'vendor-key'],
    // The trace is reduced to tool names and verdict words, so its values go by construction.
    ['trace', 'trace', 'sk-abcdefghijklmnopqrstuvwx', 'trace-values'],
  ])(
    'redacts %s — every author-written field, not just the ones named first',
    async (_label, field, secret, rule) => {
      const receipt = await submitFeedback({
        source: 'agent',
        kind: 'feature_request',
        // `text` is deliberately CLEAN, so a pass can only come from the field under test.
        text: 'a way to assert that no request fired',
        [field]: `we currently do it by ${secret}`,
      });
      expect(receipt.redacted, `${field} was not redacted`).toContain(rule);
    },
  );
});

/**
 * A trace is the literal call/response trail, and the responses carry what the page showed and
 * what was typed into it. Only Reticle's own words survive: tool names and verdict words.
 */
describe('summarizeTrace', () => {
  it('keeps tool names and verdict words, drops every value', () => {
    const trace =
      'reticle_act {"ref":"e3","action":"fill","args":{"text":"hunter2"}} -> ok\n' +
      'reticle_act_and_wait -> verified: "no" text "Welcome, Jane Smith"';
    const out = summarizeTrace(trace);
    expect(out).toBe('reticle_act ok reticle_act_and_wait verified no');
    for (const leak of ['hunter2', 'Jane', 'Smith', 'e3', 'Welcome']) {
      expect(out).not.toContain(leak);
    }
  });
});

/**
 * A reply address, only when the person gave one. It is the one personal value this channel sends,
 * so it must arrive exactly as given and must be absent from every report that did not give it.
 */
describe('a reply address on feedback', () => {
  it('sends the address as given, and only when it is given', async () => {
    const project = mkdtempSync(join(tmpdir(), 'feedback-contact-'));
    // The outbox is written under the home folder before the send. Keep it out of the real one.
    vi.stubEnv('HOME', project);
    const emit = vi.fn(() => Promise.resolve(true));
    vi.spyOn(telemetryModule, 'getTelemetry').mockReturnValue({
      emit,
      enabled: true,
      firstRun: false,
    });
    await submitFeedback(
      { source: 'human', kind: 'experience', text: 'works well', contact: 'ada@example.com' },
      { cwd: project, env: {} },
    );
    await submitFeedback(
      { source: 'human', kind: 'experience', text: 'works well' },
      { cwd: project, env: {} },
    );
    const blocks = (emit.mock.calls as unknown as [string, { feedback: Feedback }][]).map(
      (call) => call[1].feedback,
    );
    expect(blocks[0]?.contact).toBe('ada@example.com');
    expect(blocks[1]).not.toHaveProperty('contact');
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('accepts one plain address and refuses anything else', () => {
    expect(isFeedbackContact('ada@example.com')).toBe(true);
    expect(isFeedbackContact('ada example.com')).toBe(false);
    expect(isFeedbackContact('ada@example.com, bob@example.com')).toBe(false);
    expect(isFeedbackContact('ada@localhost')).toBe(false);
    expect(isFeedbackContact(`${'a'.repeat(250)}@example.com`)).toBe(false);
  });
});
