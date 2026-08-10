import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  advertisedConfig,
  advertisedTools,
  createMcpServer,
  encodeResult,
  firstSentence,
  installFriendlyArgErrors,
  withSessionEnvelope,
} from './mcp.js';
import { TOOL_SURFACE } from '../tools/tool-surface.js';
import { TOOLS, type ToolDeps } from '../tools/tools.js';
import { SESSION_BOUND_TOOLS } from '../tools/invoke-tool.js';
import { ReticleTool } from '../tools/tool-names.js';

describe('withSessionEnvelope — spliced fields survive structuredContent validation', () => {
  // `warning` rides with `session` from healthEnvelope on a throttled tab — it is spliced by runTool
  // exactly like the others, so the superset guard must cover it or a throttled tab's warning is
  // stripped on validating profiles from every session-bound tool but the one that declared it locally.
  const ENVELOPE_KEYS = ['session', 'session_lease', 'session_age_warning', 'control', 'warning'];

  it('every session-bound tool with an outputSchema declares the envelope fields (superset guard)', () => {
    for (const tool of TOOLS) {
      if (tool.outputSchema === undefined || !SESSION_BOUND_TOOLS.has(tool.name)) continue;
      const merged = withSessionEnvelope(tool.name, tool.outputSchema) ?? {};
      for (const key of ENVELOPE_KEYS) {
        expect(Object.keys(merged), `${tool.name} must keep '${key}'`).toContain(key);
      }
    }
  });

  it("keeps a tool's own field shape over the permissive envelope default (ACT session)", () => {
    const act = TOOLS.find((t) => t.name === ReticleTool.ACT);
    const merged = withSessionEnvelope(ReticleTool.ACT, act?.outputSchema) ?? {};
    // ACT declares a typed session object; the merge must not overwrite it with z.unknown.
    expect(merged['session']).toBe(act?.outputSchema?.['session']);
  });

  it('leaves a non-session-bound tool schema untouched', () => {
    const shape: z.ZodRawShape = { ok: z.boolean() };
    expect(withSessionEnvelope('not_a_session_tool', shape)).toBe(shape);
  });
});

describe('outputSchema declares every field its handler returns (field-drop guard)', () => {
  // The structuredContent-vs-outputSchema drop: on a validating profile (full/dynamic) the SDK strips
  // any returned key the schema does not declare. Each entry pins a field the handler is KNOWN to
  // return so a future schema edit that drops it fails here instead of silently vanishing from the
  // agent's view. This is the per-field backlog of the systematic returned-keys ⊆ declared-keys guard.
  const REQUIRED_FIELDS: Array<[string, string[]]> = [
    [ReticleTool.OBSERVE, ['window_ms']],
    [ReticleTool.FLOW_REPLAY, ['name']],
    [ReticleTool.ACT_AND_WAIT, ['source', 'capsuleSaved', 'paused', 'guidance', 'hint']],
    [ReticleTool.ACT, ['paused', 'guidance', 'hint']],
    [ReticleTool.ACT_SEQUENCE, ['paused', 'guidance', 'hint']],
    [ReticleTool.CAPABILITIES, ['generatedAt', 'governance']],
  ];
  for (const [name, fields] of REQUIRED_FIELDS) {
    it(`${name} declares ${fields.join(', ')}`, () => {
      const tool = TOOLS.find((t) => t.name === name);
      const keys = Object.keys(tool?.outputSchema ?? {});
      for (const f of fields) {
        expect(
          keys,
          `${name} outputSchema must declare '${f}' or it is stripped on validating profiles`,
        ).toContain(f);
      }
    });
  }
});

describe('encodeResult', () => {
  const result = { calls: [{ method: 'GET', url: '/api/x', status: 500 }] };

  it('defaults to compact JSON (no indentation whitespace)', () => {
    const text = encodeResult(result, '');
    expect(text).toBe('{"calls":[{"method":"GET","url":"/api/x","status":500}]}');
    expect(text).not.toContain('\n');
  });

  it('compact is strictly smaller than the pretty form for a structured payload', () => {
    expect(encodeResult(result, '').length).toBeLessThan(encodeResult(result, 'pretty').length);
  });

  it('opts back into indented JSON with encoding "pretty"', () => {
    const text = encodeResult(result, 'pretty');
    expect(text).toBe(JSON.stringify(result, null, 2));
    expect(text).toContain('\n');
  });

  it('round-trips to the same value regardless of encoding', () => {
    expect(JSON.parse(encodeResult(result, ''))).toEqual(result);
    expect(JSON.parse(encodeResult(result, 'pretty'))).toEqual(result);
  });
});

describe('lean profiles drop the advertised outputSchema without losing structuredContent', () => {
  // The schema-tax reduction rests on ONE SDK guarantee: a tool registered with no outputSchema still
  // delivers its structuredContent. If a future SDK bump breaks that, dropping the schema on lean
  // profiles would silently strip the typed object an agent might rely on — a false-green-shaped
  // regression — so the guarantee is pinned here rather than assumed. In-memory, no daemon, fast gate.
  it('the SDK carries structuredContent for a tool declared WITHOUT an outputSchema', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');

    const server = new McpServer({ name: 'test', version: '0' });
    server.registerTool('noschema', { description: 'x' }, () => ({
      content: [{ type: 'text' as const, text: '{"a":1,"b":2}' }],
      structuredContent: { a: 1, b: 2 },
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'c', version: '0' });
    await client.connect(clientTransport);

    const listed = await client.listTools();
    const tool = listed.tools.find((t) => 'noschema' === t.name);
    expect(tool?.outputSchema).toBeUndefined(); // nothing advertised → no schema tax

    const result = await client.callTool({ name: 'noschema', arguments: {} });
    expect(result.structuredContent).toEqual({ a: 1, b: 2 }); // …yet the typed object still arrives
    await client.close();
    await server.close();
  });
});

/**
 * Lean profiles trim each description to its first sentence, and the splitter looked for the first
 * `". "`. "e.g. " satisfies that, so every description carrying an example was cut off inside the
 * abbreviation — `reticle_act`'s ref reached the agent as "…reticle_query (e.g." and stopped, losing
 * both the example and the ref-lifetime contract stated after it. It degraded only the DEFAULT
 * profile, which is the one whose raw strings nobody reads.
 *
 * These call `firstSentence` directly. The first version of this test read the tool definitions
 * instead, which are trimmed LATER during registration — so it exercised none of the trimming and
 * would have passed with the bug fully present. A guard that cannot fail is worse than no guard.
 */
describe('firstSentence does not cut inside an abbreviation', () => {
  it('keeps the text that follows "e.g."', () => {
    const trimmed = firstSentence(
      "Element ref (e.g. 'e42') from reticle_snapshot — stable until the element leaves the DOM.",
    );
    expect(trimmed).toContain("e.g. 'e42'");
    expect(trimmed).toContain('leaves the DOM');
  });

  it.each(['i.e.', 'etc.', 'vs.', 'cf.'])('does not stop at "%s"', (abbr) => {
    expect(firstSentence(`Alpha ${abbr} beta gamma.`)).toContain('gamma');
  });

  it('still stops at a real sentence end', () => {
    expect(firstSentence('First one. Second one.')).toBe('First one.');
  });

  /**
   * A description may legitimately END on an abbreviation ("GET | POST | … etc."). What must never
   * happen is TRIMMING creating one, so this only flags text the trim actually shortened.
   */
  it.each(advertisedTools(TOOL_SURFACE.DEFAULT).map((tool) => [tool.name, tool] as const))(
    '%s: trimming never creates a dangling abbreviation',
    (_name, tool) => {
      const texts = [
        tool.description,
        ...Object.values(tool.inputSchema).map((s) => s.description ?? ''),
      ].filter((text) => text.length > 0);
      for (const text of texts) {
        const trimmed = firstSentence(text);
        if (trimmed === text) continue;
        expect(trimmed.trimEnd()).not.toMatch(/\b(e\.g|i\.e|etc|vs|cf)\.$/);
      }
    },
  );
});

/**
 * Every predicate parameter must stay SELF-SUFFICIENT.
 *
 * A previous version stated the kinds on one tool and pointed the other five at it, saving 790 B per
 * turn. That was the wrong trade: writing a predicate then required joining two tool descriptions,
 * and a fumbled join is a wrong call, which costs far more than the bytes saved. Only the "call
 * reticle_tools for field details" sentence is anchored now — that one is navigation, so stating it
 * once loses nothing.
 */
describe('every predicate parameter can be used without reading another tool', () => {
  const advertised = advertisedTools(TOOL_SURFACE.DEFAULT);

  /** The REAL advertised text, via the same builder registration uses. */
  const predicateTexts = (): string[] =>
    advertised.flatMap((tool) =>
      Object.entries(advertisedConfig(tool, advertised, TOOL_SURFACE.DEFAULT).inputSchema)
        // Select by SHAPE, not by name. `until` is overloaded — reticle_observe/_network/_console
        // use it for a numeric cursor bound — and selecting by name here made this suite assert that
        // a NUMBER should carry predicate grammar, which is the bug it was meant to guard against.
        .filter(([, schema]) => (schema.description ?? '').includes('Predicate object'))
        .map(([, schema]) => schema.description ?? ''),
    );

  it('covers several tools (otherwise this proves nothing)', () => {
    expect(predicateTexts().length).toBeGreaterThan(1);
  });

  it('carries the kind list on EVERY predicate parameter', () => {
    for (const text of predicateTexts()) {
      expect(text, 'a predicate param must name its kinds').toContain('allOf | anyOf | not');
    }
  });

  it('never sends the agent to another tool to learn the grammar', () => {
    for (const text of predicateTexts()) {
      expect(text).not.toMatch(/same grammar as/i);
    }
  });

  it('states the field-grammar pointer once, since that part is only navigation', () => {
    const hints = predicateTexts().filter((t) => t.includes('full field grammar'));
    expect(hints).toHaveLength(1);
  });
});

/**
 * A wrong argument SHAPE is the most common failure an agent has here, and the one this package's
 * error handling never saw: the SDK validates and throws BEFORE the handler runs, so the reply was
 * the validator's internal state — naming no field and showing no correct call. Two failed round
 * trips guessing `reticle_act`'s shape were observed live, which costs more than the lean snapshot
 * saves.
 *
 * This drives a real client over an in-memory transport rather than calling the wrapper directly,
 * because the fix hangs on an SDK-internal method name: if that is renamed upstream, the override
 * stops applying and the raw dump comes back silently. Testing the wrapper in isolation would stay
 * green through exactly that regression.
 */
describe('a wrong-shaped call is answered with a correct one', () => {
  /**
   * Validation fails before any handler runs, so the deps never get used — the point is only that a
   * real server can be constructed and driven over a real transport.
   */
  const toolDepsForTest = (): ToolDeps =>
    ({ sessions: { resolve: () => ({ id: 'x' }) } }) as unknown as ToolDeps;

  /** The text an agent actually reads. Comparing the JSON-encoded form escapes the very quotes the
   *  example is made of, which made a passing message look like a failing one. */
  const errorText = (result: unknown): string => {
    const content = (result as { content?: unknown }).content;
    const blocks = Array.isArray(content) ? content : [];
    return blocks
      .map((b) =>
        'object' === typeof b && b !== null ? String((b as { text?: unknown }).text) : '',
      )
      .join(' ');
  };

  const openServer = async (): Promise<{
    client: import('@modelcontextprotocol/sdk/client/index.js').Client;
    close: () => Promise<void>;
  }> => {
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const server = createMcpServer(toolDepsForTest(), TOOL_SURFACE.DEFAULT);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'c', version: '0' });
    await client.connect(clientTransport);
    return {
      client,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  };

  it('appends the tool’s own valid example to a validation failure', async () => {
    const { client, close } = await openServer();
    // The exact mistake made live: `action` at the top level with a testid, instead of ref + args.
    const result = await client.callTool({
      name: ReticleTool.ACT,
      arguments: { action: 'click', testid: 'break' },
    });
    const failure = errorText(result);

    expect(result.isError, 'the call must still be rejected').toBe(true);
    expect(failure, 'it must show what a correct call looks like').toContain(
      'A valid call looks like',
    );
    expect(failure).toContain('"action":"fill"');
    await close();
  });

  it('still names the offending field, so the reason is not lost', async () => {
    const { client, close } = await openServer();
    const result = await client.callTool({
      name: ReticleTool.ACT,
      arguments: { action: 'click', testid: 'break' },
    });
    expect(errorText(result)).toMatch(/ref/i);
    // The code must be stated ONCE — the wrapper used to re-prefix an already-prefixed message.
    expect(errorText(result)).not.toMatch(/MCP error.*MCP error/);
    await close();
  });

  it('formats a missing session action without exposing the raw zod issue', async () => {
    const { client, close } = await openServer();
    const result = await client.callTool({
      name: ReticleTool.SESSION,
      arguments: {},
    });
    const failure = errorText(result);

    expect(result.isError, 'the call must still be rejected').toBe(true);
    expect(failure).toContain('Missing required parameter for reticle_session: action');
    expect(failure).toContain('one of: tune, yield, end, resume, messages, review, narrate');
    expect(failure).toContain('Nothing ran.');
    expect(failure).toContain('A valid call looks like');
    expect(failure, 'the internal zod issue must not reach the agent').not.toContain('"code"');
    expect(failure).not.toContain('Input validation error');
    await close();
  });

  // The handshake is the ONLY channel that reaches an agent with no CLAUDE.md, no pasted skill and
  // no finished `reticle init` — which is the agent whose setup just broke, and whose report we would
  // otherwise never get. Asserted over a real client connection, because instructions that are set
  // but not transmitted look identical from inside the server.
  it('tells the agent at connect time that feedback is first-class', async () => {
    const { client, close } = await openServer();
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('Feedback is first-class');
    expect(instructions).toContain(ReticleTool.FEEDBACK);
    // Including the phase before the tools work at all.
    expect(instructions).toMatch(/install, the wiring, or the setup/);
    expect(instructions).toContain('reticle feedback --agent --kind');
    await close();
  });

  it('points at reticle_tools when the tool carries no example', () => {
    const server = createMcpServer(toolDepsForTest(), TOOL_SURFACE.DEFAULT);
    // Installed with an empty example map: the fallback must still be actionable, never a bare dump.
    installFriendlyArgErrors(server, new Map());
    expect(typeof server).toBe('object');
  });
});

/**
 * An unknown parameter is the failure zod cannot catch: object schemas are non-strict, so the key is
 * dropped and the tool answers as if it had not been asked.
 *
 * Measured live on the Electron demo: `reticle_clock { action: "freeze" }` returned
 * `{"frozen":false}` — a well-formed NEGATIVE that reads as a fact about the app ("the clock is not
 * frozen") when it means "you named the parameter wrong". The correct call, `{ freeze: true }`,
 * returned `{"frozen":true}`. A caller cannot tell those two replies apart, which makes every tool a
 * false-negative generator for one typo.
 */
describe('an unknown parameter is refused, never silently dropped', () => {
  const openServer = async (): Promise<{
    client: import('@modelcontextprotocol/sdk/client/index.js').Client;
    close: () => Promise<void>;
  }> => {
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const server = createMcpServer(
      { sessions: { resolve: () => ({ id: 'x' }) } } as unknown as ToolDeps,
      TOOL_SURFACE.DEFAULT,
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 'c', version: '0' });
    await client.connect(ct);
    return {
      client,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  };

  const text = (result: unknown): string => {
    const content = (result as { content?: unknown }).content;
    return (Array.isArray(content) ? content : [])
      .map((b) =>
        'object' === typeof b && b !== null ? String((b as { text?: unknown }).text) : '',
      )
      .join(' ');
  };

  it('rejects a misspelled parameter instead of computing without it', async () => {
    const { client, close } = await openServer();
    const result = await client.callTool({
      name: ReticleTool.SNAPSHOT,
      arguments: { mdoe: 'interactive' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('mdoe');
    expect(text(result), 'it must say the value was not applied').toMatch(/NOT applied/i);
    await close();
  });

  it('shows a valid call alongside the refusal', async () => {
    const { client, close } = await openServer();
    const result = await client.callTool({
      name: ReticleTool.SNAPSHOT,
      arguments: { mdoe: 'interactive' },
    });
    expect(text(result)).toContain('A valid call looks like');
    await close();
  });

  it('still accepts a correctly-spelled call', async () => {
    const { client, close } = await openServer();
    const result = await client.callTool({
      name: ReticleTool.SNAPSHOT,
      arguments: { mode: 'interactive' },
    });
    // It may fail for lack of a real session, but NOT for an unknown parameter.
    expect(text(result)).not.toMatch(/Unknown parameter/i);
    await close();
  });
});
