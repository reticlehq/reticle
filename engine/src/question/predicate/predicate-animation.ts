import { SESSION_REF } from '@reticlehq/core';
import { str, num, type EvalResult } from './predicate-eval-kit.js';

export interface AnimationEvent {
  completed: boolean;
  data: Record<string, unknown>;
  ref?: string;
}

interface AnimationPredicate {
  name?: string;
  target?: string;
  completed?: boolean;
  since?: number;
}

interface AnimationTargetDescriptor {
  ref?: string;
  role?: string;
  name?: string;
  text?: string;
}

export interface AnimationObservation {
  name?: string;
  playState?: string;
  target?: AnimationTargetDescriptor | null;
  targetMatches?: boolean;
}

export interface AnimationTargetResolution {
  target?: string;
  matched?: boolean;
  refs?: readonly string[];
  count?: number;
  invalid?: boolean;
  truncated?: boolean;
}

export interface AnimationSnapshot {
  animations: readonly AnimationObservation[];
  target?: AnimationTargetResolution;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return 'object' === typeof value && null !== value && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function strings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((one): one is string => 'string' === typeof one);
}

function animationTargetDescriptor(value: unknown): AnimationTargetDescriptor | null | undefined {
  if (null === value) return null;
  const target = record(value);
  if (target === undefined) return undefined;
  const ref = str(target['ref']);
  const role = str(target['role']);
  const name = str(target['name']);
  const text = str(target['text']);
  return {
    ...(ref === undefined ? {} : { ref }),
    ...(role === undefined ? {} : { role }),
    ...(name === undefined ? {} : { name }),
    ...(text === undefined ? {} : { text }),
  };
}

function animationObservation(value: unknown): AnimationObservation | undefined {
  const row = record(value);
  if (row === undefined) return undefined;
  const target = animationTargetDescriptor(row['target']);
  const name = str(row['name']);
  const playState = str(row['playState']);
  return {
    ...(name === undefined ? {} : { name }),
    ...(playState === undefined ? {} : { playState }),
    ...(target === undefined ? {} : { target }),
    ...(true === row['targetMatches'] || false === row['targetMatches']
      ? { targetMatches: row['targetMatches'] }
      : {}),
  };
}

function animationTargetResolution(value: unknown): AnimationTargetResolution | undefined {
  const target = record(value);
  if (target === undefined) return undefined;
  const refs = strings(target['refs']);
  const targetValue = str(target['target']);
  const count = num(target['count']);
  return {
    ...(targetValue === undefined ? {} : { target: targetValue }),
    ...(true === target['matched'] || false === target['matched']
      ? { matched: target['matched'] }
      : {}),
    ...(refs === undefined ? {} : { refs }),
    ...(count === undefined ? {} : { count }),
    ...(true === target['invalid'] ? { invalid: true } : {}),
    ...(true === target['truncated'] ? { truncated: true } : {}),
  };
}

export function animationSnapshotFrom(value: unknown): AnimationSnapshot | undefined {
  const result = record(value);
  if (result === undefined || !Array.isArray(result['animations'])) return undefined;
  const target = animationTargetResolution(result['target']);
  return {
    animations: result['animations']
      .map(animationObservation)
      .filter((row): row is AnimationObservation => row !== undefined),
    ...(target === undefined ? {} : { target }),
  };
}

function targetRef(target: AnimationTargetDescriptor | null | undefined): string | undefined {
  return null === target ? undefined : target?.ref;
}

function eventMatchesTarget(
  event: AnimationEvent,
  p: AnimationPredicate,
  live: AnimationSnapshot | undefined,
): boolean {
  if (p.target === undefined) return true;
  const refs = live?.target?.refs;
  if (refs !== undefined) return event.ref !== undefined && refs.includes(event.ref);
  return event.ref === p.target;
}

function targetMatchesLive(
  animation: AnimationObservation,
  p: AnimationPredicate,
  live: AnimationSnapshot | undefined,
): boolean {
  if (p.target === undefined) return true;
  if (animation.targetMatches !== undefined) return animation.targetMatches;
  const ref = targetRef(animation.target);
  if (ref === undefined) return false;
  const refs = live?.target?.refs;
  return refs === undefined ? ref === p.target : refs.includes(ref);
}

function playStateMatches(animation: AnimationObservation, p: AnimationPredicate): boolean {
  if (true === p.completed) return 'finished' === animation.playState;
  return animation.playState !== undefined && !['finished', 'idle'].includes(animation.playState);
}

function matchesLiveAnimation(
  animation: AnimationObservation,
  p: AnimationPredicate,
  live: AnimationSnapshot | undefined,
): boolean {
  if (p.name !== undefined && animation.name !== p.name) return false;
  if (!targetMatchesLive(animation, p, live)) return false;
  return playStateMatches(animation, p);
}

function describeAnimationTarget(target: AnimationTargetDescriptor | null | undefined): string {
  if (null === target) return 'no target';
  if (target === undefined) return 'unknown target';
  const label =
    target.name !== undefined && target.name.length > 0
      ? `${target.role ?? 'element'} ${JSON.stringify(target.name)}`
      : (target.role ?? target.text ?? 'element');
  return target.ref === undefined ? label : `${label} (${target.ref})`;
}

function describeAnimationObservation(animation: AnimationObservation): string {
  const name = animation.name ?? '(unnamed)';
  const playState = animation.playState ?? 'unknown state';
  return `${name} on ${describeAnimationTarget(animation.target)} (${playState})`;
}

function observedAnimations(
  events: readonly AnimationEvent[],
  live: AnimationSnapshot | undefined,
): string {
  const liveObserved = live?.animations.map(describeAnimationObservation) ?? [];
  if (liveObserved.length > 0) return `current animations: ${liveObserved.join('; ')}`;
  const eventObserved = events.map((event) => {
    const name = str(event.data['name']) ?? '(unnamed)';
    const kind = event.completed ? 'ended' : 'started';
    return event.ref === undefined ? `${name} ${kind}` : `${name} ${kind} on ${event.ref}`;
  });
  return eventObserved.length > 0
    ? `animation events in the window: ${eventObserved.join('; ')}`
    : live === undefined
      ? 'no matching animation in the window'
      : 'no matching animation in the window and none currently reported by the page';
}

function animationTargetMiss(
  p: AnimationPredicate,
  target: AnimationTargetResolution | undefined,
): EvalResult | undefined {
  if (p.target === undefined || target === undefined || true === target.matched) return undefined;
  const quoted = JSON.stringify(p.target);
  const reason =
    true === target.invalid
      ? `animation target selector ${quoted} is not a valid CSS selector`
      : `animation target ${SESSION_REF.test(p.target) ? 'ref' : 'selector'} ${quoted} matched no element`;
  return {
    pass: false,
    failureReason: reason,
    observed:
      true === target.invalid
        ? 'the target selector could not be parsed'
        : 'the target resolved to no element',
    expected: 'a target selector that resolves to an element, or a live Reticle ref like e12',
    assertion: 'animation.target',
  };
}

function animationMiss(
  events: readonly AnimationEvent[],
  p: AnimationPredicate,
  live: AnimationSnapshot | undefined,
): EvalResult {
  return {
    pass: false,
    failureReason: `no animation matched ${JSON.stringify(p)}`,
    observed: observedAnimations(events, live),
    expected: `an animation matching ${JSON.stringify(p)}`,
    assertion: 'animation.present',
  };
}

export function evalAnimation(
  events: readonly AnimationEvent[],
  p: AnimationPredicate,
  live?: AnimationSnapshot,
): EvalResult {
  const wantCompleted = true === p.completed;
  const hit = events.find((event) => {
    if (event.completed !== wantCompleted) return false;
    if (p.name !== undefined && str(event.data['name']) !== p.name) return false;
    if (!eventMatchesTarget(event, p, live)) return false;
    return true;
  });
  if (hit !== undefined) return { pass: true, evidence: hit.data };
  const targetMiss = animationTargetMiss(p, live?.target);
  if (targetMiss !== undefined) return targetMiss;
  const liveHit =
    p.since === undefined
      ? live?.animations.find((animation) => matchesLiveAnimation(animation, p, live))
      : undefined;
  return liveHit !== undefined ? { pass: true, evidence: liveHit } : animationMiss(events, p, live);
}
