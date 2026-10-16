import {
  ActionType,
  DEFAULT_PRODUCTION_POLICY,
  EventType,
  HelloScope,
  MessageKind,
  ProductionRule,
  ReticleCommand,
  asRecord,
  asString,
  productionRefusal,
  type CommandResult,
  type LiftableProductionRule,
  type ProductionPolicyEntry,
  type ReticleEvent,
} from '@reticlehq/core';

/**
 * One production drive: what it was granted, what it created, and the rule that refuses an act.
 *
 * Enforced where the daemon dispatches a command (`Session.command`) and, on a leased browser, where
 * the page's requests leave it. The page is never asked. Two things are recognised:
 *
 * - the control an act would press: its name, text, value, test id, link and form target;
 * - the request it would send: method and path against the policy list.
 *
 * An action passes when the drive's declared intent names it, or when it touches only something
 * this drive created (an id it saw come back from a 2xx create).
 */

/** Commands that read or move around. Everything else a page is told to do is an act. */
const READ_COMMANDS: ReadonlySet<string> = new Set([
  ReticleCommand.SNAPSHOT,
  ReticleCommand.QUERY,
  ReticleCommand.MATCH,
  ReticleCommand.INSPECT,
  ReticleCommand.ANIMATIONS,
  ReticleCommand.NARRATE,
  ReticleCommand.CAPABILITIES,
  ReticleCommand.STATE_READ,
  ReticleCommand.STORAGE_READ,
  ReticleCommand.SCROLL,
  ReticleCommand.SESSION_CONFIG,
  ReticleCommand.PRESENTER,
  ReticleCommand.IMPACT,
  ReticleCommand.CAPTURE,
  ReticleCommand.RENDER,
  ReticleCommand.NAVIGATE,
  ReticleCommand.REFRESH,
  ReticleCommand.FLOWS,
  ReticleCommand.FLOW_PROGRESS,
  ReticleCommand.PLAN,
  ReticleCommand.MARKERS,
]);

/** Acts that only move the pointer or the view. They press nothing. */
const LOOKING_ACTIONS: ReadonlySet<string> = new Set([
  ActionType.HOVER,
  ActionType.FOCUS,
  ActionType.BLUR,
  ActionType.SCROLL,
  ActionType.SCROLL_INTO_VIEW,
]);

/** Each refused action as words on a control, and as words in an intent. */
const RULE_WORDS: readonly (readonly [LiftableProductionRule, RegExp])[] = [
  [
    ProductionRule.CANCEL_SUBSCRIPTION,
    /\bcancel\b.{0,40}\b(?:subscription|plan|trial|membership)\b|\bdowngrade\b|\/subscriptions?\b.*\bcancel/i,
  ],
  [
    ProductionRule.DELETE_WORKSPACE,
    /\b(?:delete|remove|destroy|erase)\b.{0,40}\b(?:workspace|project|organi[sz]ation|org|account)s?\b/i,
  ],
  [
    ProductionRule.REVOKE_KEY,
    /\b(?:revoke|rotate|regenerate|roll)\b.{0,40}\b(?:key|token|secret)s?\b|\brevoke\b/i,
  ],
  [
    ProductionRule.SEND_INVITE,
    /\binvit(?:e|es|ed|ing|ation|ations)\b|\/invit|\bsend (?:an? )?(?:email|invite|invitation)s?\b|\bresend\b|\bemail (?:it|them|the)\b/i,
  ],
  [
    ProductionRule.CHANGE_ROLE,
    /\bchange (?:the |their |a |his |her )?(?:member'?s? )?role\b|\bmake (?:an? |them )?(?:admin|owner)\b|\bpromote\b|\bdemote\b|\bset role\b|\btransfer ownership\b/i,
  ],
  [
    ProductionRule.PAYMENT,
    /\b(?:pay|pays|paying|payment|purchase|buy|checkout|check out|subscribe|upgrade|place order|confirm order|add (?:a )?card)\b|\/(?:billing|checkout)\b/i,
  ],
];

/** A word that turns the action after it into one the intent forbids: "does not invite". */
const NEGATION = /\b(?:not|no|never|without|nor|avoid|don't|doesn't|won't)\b/i;
const NEGATION_REACH = 4;

/**
 * The refused actions an intent asks for in so many words. "Invite a teammate" asks for one;
 * "she does not invite anybody" asks for none.
 */
// ponytail: the same negation rule as `outwardActionsAsked` in core; one helper once both settle.
export function rulesAsked(intent: string): LiftableProductionRule[] {
  const asked: LiftableProductionRule[] = [];
  for (const [rule, pattern] of RULE_WORDS) {
    for (const match of intent.matchAll(new RegExp(pattern.source, 'gi'))) {
      const before = intent.slice(0, match.index).split(/\s+/).slice(-NEGATION_REACH).join(' ');
      if (!NEGATION.test(before)) {
        asked.push(rule);
        break;
      }
    }
  }
  return asked;
}

/** The refused action a control's own words name, if any. */
export function controlRule(words: string): LiftableProductionRule | undefined {
  const text = words.replace(/[_-]+/g, ' ');
  return RULE_WORDS.find(([, pattern]) => pattern.test(text) || pattern.test(words))?.[0];
}

/** The policy entry a request matches, if any. */
export function requestRule(
  policy: readonly ProductionPolicyEntry[],
  method: string,
  url: string,
  base?: string,
): LiftableProductionRule | undefined {
  let pathname: string;
  try {
    pathname = new URL(url, base ?? 'http://localhost').pathname;
  } catch {
    return undefined;
  }
  const verb = method.toUpperCase();
  return policy.find(
    (entry) =>
      entry.methods.some((m) => m.toUpperCase() === verb) &&
      new RegExp(entry.path, 'i').test(pathname),
  )?.rule;
}

/** What a production nonce grants. Supplied by the local caller that mints it. */
export interface ProductionGrant {
  scope: HelloScope;
  /** The drive's declared intent, in words. It is what lifts a refused rule. */
  intent?: string;
  /** The service's refused requests. Absent: the default list. */
  policy?: readonly ProductionPolicyEntry[];
  /** The origin the drive was activated on. */
  origin?: string;
}

/** The text a control shows about itself, from an INSPECT reply or an act's own target. */
function controlWords(descriptor: unknown): string {
  const d = asRecord(descriptor);
  return ['name', 'text', 'label', 'value', 'testid', 'href', 'formAction']
    .map((key) => asString(d[key]) ?? '')
    .join(' ');
}

/** The shortest created id that counts. Shorter strings match too much by accident. */
const MIN_CREATED_ID_LENGTH = 4;

export class ProductionDrive {
  #scope: HelloScope;
  readonly #intentAllows: ReadonlySet<LiftableProductionRule>;
  #policy: readonly ProductionPolicyEntry[];
  readonly #origin: string | undefined;
  readonly #expiresAt: number;
  readonly #clock: () => number;
  /** Ids this drive saw come back from its own creates. Deleting those is allowed. */
  readonly #created = new Set<string>();
  /** Refusals made outside a command (a blocked request), told to the next act. */
  #pending: string | undefined;

  constructor(grant: ProductionGrant & { expiresAt: number }, clock: () => number) {
    this.#scope = grant.scope;
    this.#intentAllows = new Set(rulesAsked(grant.intent ?? ''));
    this.#policy = grant.policy ?? DEFAULT_PRODUCTION_POLICY;
    this.#origin = grant.origin;
    this.#expiresAt = grant.expiresAt;
    this.#clock = clock;
  }

  get scope(): HelloScope {
    return this.#scope;
  }

  /** The service's refused requests, from the ticket. Set before the page opens. */
  setPolicy(policy: readonly ProductionPolicyEntry[]): void {
    this.#policy = policy;
  }

  /** A page may narrow its drive to observing. Nothing widens it again. */
  narrowToObserve(): void {
    this.#scope = HelloScope.OBSERVE;
  }

  /** Learn ids from what the drive created: a 2xx POST/PUT whose JSON body names an `id`. */
  noteEvent(event: ReticleEvent): void {
    if (event.type !== EventType.NET_REQUEST) return;
    const data = event.data;
    const method = (asString(data['method']) ?? '').toUpperCase();
    const status = data['status'];
    if ('number' !== typeof status || status < 200 || status > 299) return;
    // A refused request that SUCCEEDED got past every guard (no leased browser to stop it). The
    // drive cannot take it back; it stops acting and says why on the next act.
    const url = asString(data['url']) ?? '';
    const rule = requestRule(this.#policy, method, url, this.#origin);
    if (rule !== undefined && !this.#lifted(rule, url)) this.#pending ??= productionRefusal(rule);
    if (method !== 'POST' && method !== 'PUT') return;
    const body = asString(data['responseBody']);
    if (body === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return;
    }
    const top = asRecord(parsed);
    const candidates = [top['id'], ...Object.values(top).map((v) => asRecord(v)['id'])];
    for (const id of candidates) {
      const text = 'number' === typeof id ? String(id) : asString(id);
      if (text !== undefined && MIN_CREATED_ID_LENGTH <= text.length) this.#created.add(text);
    }
  }

  #createdHere(text: string): boolean {
    for (const id of this.#created) if (text.includes(id)) return true;
    return false;
  }

  #lifted(rule: LiftableProductionRule, touched: string): boolean {
    return this.#intentAllows.has(rule) || this.#createdHere(touched);
  }

  /** The refusal for a request the page is about to send, or undefined to let it go. */
  refuseRequest(method: string, url: string): string | undefined {
    const rule = requestRule(this.#policy, method, url, this.#origin);
    if (rule === undefined || this.#lifted(rule, url)) return undefined;
    const refusal = productionRefusal(rule);
    this.#pending = refusal;
    return refusal;
  }

  /** A refusal made outside a command, once. */
  takePending(): string | undefined {
    const pending = this.#pending;
    this.#pending = undefined;
    return pending;
  }

  /**
   * The refusal for a command, or undefined to send it. `inspect` reads a ref's control from the
   * page: what the control says about itself is evidence; what it does is decided here.
   */
  async refuseCommand(
    name: string,
    args: Record<string, unknown>,
    inspect: (ref: string) => Promise<unknown>,
  ): Promise<string | undefined> {
    if (this.#expiresAt <= this.#clock()) return productionRefusal(ProductionRule.EXPIRED);
    if (name === ReticleCommand.NAVIGATE) return this.#refuseNavigation(asString(args['url']));
    if (READ_COMMANDS.has(name)) return undefined;
    const pending = this.takePending();
    if (pending !== undefined) return pending;
    if (this.#scope === HelloScope.OBSERVE) return productionRefusal(ProductionRule.OBSERVE_ONLY);
    const steps =
      name === ReticleCommand.ACT_SEQUENCE
        ? (Array.isArray(args['steps']) ? args['steps'] : []).map(asRecord)
        : name === ReticleCommand.ACT
          ? [args]
          : [];
    for (const step of steps) {
      const refusal = await this.#refuseStep(step, inspect);
      if (refusal !== undefined) return refusal;
    }
    return undefined;
  }

  /**
   * Send a command through the policy. A refusal comes back as a failed result naming the rule,
   * never as a silent no-op; a request the act sent and the guard refused fails the act that sent it.
   */
  async gate(
    name: string,
    args: Record<string, unknown>,
    send: (name: string, args: Record<string, unknown>) => Promise<CommandResult>,
  ): Promise<CommandResult> {
    const inspect = async (ref: string): Promise<unknown> =>
      (await send(ReticleCommand.INSPECT, { ref })).result;
    const refusal = await this.refuseCommand(name, args, inspect);
    if (refusal !== undefined) return refusedCommand(refusal);
    const result = await send(name, args);
    if (READ_COMMANDS.has(name)) return result;
    const late = this.takePending();
    return late === undefined ? result : refusedCommand(late);
  }

  #refuseNavigation(url: string | undefined): string | undefined {
    if (url === undefined || this.#origin === undefined) return undefined;
    try {
      if (new URL(url, this.#origin).origin === this.#origin) return undefined;
    } catch {
      return undefined;
    }
    return productionRefusal(ProductionRule.OFF_ORIGIN);
  }

  async #refuseStep(
    step: Record<string, unknown>,
    inspect: (ref: string) => Promise<unknown>,
  ): Promise<string | undefined> {
    const action = asString(step['action']) ?? ActionType.CLICK;
    if (LOOKING_ACTIONS.has(action)) return undefined;
    const ref = asString(step['ref']);
    const control = ref === undefined ? asRecord(step['target']) : await inspect(ref);
    const words = controlWords(control);
    // A role picker says "Admin" in its value and "Role" in its name: selecting one changes a role.
    const picksRole = action === ActionType.SELECT && /\brole\b/i.test(words);
    const formAction = asString(asRecord(control)['formAction']);
    const rule =
      (picksRole ? ProductionRule.CHANGE_ROLE : controlRule(words)) ??
      (formAction === undefined
        ? undefined
        : requestRule(this.#policy, 'POST', formAction, this.#origin));
    if (rule === undefined || this.#lifted(rule, words)) return undefined;
    return productionRefusal(rule);
  }
}

/** A refusal in the shape every command result has: `ok: false`, the rule in `error`. */
function refusedCommand(error: string): CommandResult {
  return { kind: MessageKind.COMMAND_RESULT, id: REFUSED_ID, ok: false, error };
}

const REFUSED_ID = 'production-policy';

/** The ref a native gesture is judged under: the control was already inspected, so none is read. */
const NATIVE_REF = 'native';

/**
 * Judge a native (CDP) gesture, which reaches the page without `Session.command`. Throws the
 * refusal so the gesture is never performed.
 */
export async function assertNativeAllowed(
  drive: ProductionDrive | undefined,
  action: string,
  inspected: unknown,
): Promise<void> {
  if (drive === undefined) return;
  const refusal = await drive.refuseCommand(ReticleCommand.ACT, { ref: NATIVE_REF, action }, () =>
    Promise.resolve(inspected),
  );
  if (refusal !== undefined) throw new Error(refusal);
}
