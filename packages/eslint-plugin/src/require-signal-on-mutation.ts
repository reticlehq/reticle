/**
 * Rule: require-signal-on-mutation.
 *
 * Flags a function that CALLS a configured mutator but never calls the
 * signal callee anywhere in that SAME function body. Keeps the Reticle signal
 * layer self-enforcing (pairs with commitAndSignal).
 *
 * Scoping is per-function: a signal in an enclosing or inner function does
 * NOT credit a mutation in a different function. Each frame stands alone.
 */

import { AST_NODE_TYPES, ESLintUtils, type TSESTree } from '@typescript-eslint/utils';
import { DOCS_URL_ROOT, MessageId, MUTATION_WITHOUT_SIGNAL_MESSAGE } from './constants.js';
import { normalizeOptions, OPTIONS_SCHEMA, type RawRuleOptions } from './options.js';

const createRule = ESLintUtils.RuleCreator((name) => `${DOCS_URL_ROOT}#${name}`);

type Options = [RawRuleOptions];
type MessageIds = typeof MessageId.MUTATION_WITHOUT_SIGNAL;

interface FnFrame {
  calledSignal: boolean;
  mutatorNode: TSESTree.CallExpression | null;
}

/** Resolve the callee name of a CallExpression by NAME (ignores the object). */
function calleeName(node: TSESTree.CallExpression): string | null {
  const callee = node.callee;
  if (callee.type === AST_NODE_TYPES.Identifier) {
    return callee.name;
  }
  if (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    callee.computed === false &&
    callee.property.type === AST_NODE_TYPES.Identifier
  ) {
    return callee.property.name;
  }
  return null;
}

export const requireSignalOnMutation = createRule<Options, MessageIds>({
  name: 'require-signal-on-mutation',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require an Reticle signal alongside any user-visible store mutation so the signal layer cannot drift.',
    },
    schema: OPTIONS_SCHEMA as [],
    messages: {
      [MessageId.MUTATION_WITHOUT_SIGNAL]: MUTATION_WITHOUT_SIGNAL_MESSAGE,
    },
  },
  defaultOptions: [{}],
  create(context) {
    const { mutators, signalCallees } = normalizeOptions(context.options[0]);
    const stack: FnFrame[] = [];

    function enterFn(): void {
      stack.push({ calledSignal: false, mutatorNode: null });
    }

    function exitFn(): void {
      const frame = stack.pop();
      if (frame === undefined) return;
      if (frame.mutatorNode !== null && frame.calledSignal === false) {
        context.report({
          node: frame.mutatorNode,
          messageId: MessageId.MUTATION_WITHOUT_SIGNAL,
        });
      }
    }

    return {
      FunctionDeclaration: enterFn,
      'FunctionDeclaration:exit': exitFn,
      FunctionExpression: enterFn,
      'FunctionExpression:exit': exitFn,
      ArrowFunctionExpression: enterFn,
      'ArrowFunctionExpression:exit': exitFn,
      CallExpression(node: TSESTree.CallExpression): void {
        const frame = stack.at(-1);
        if (frame === undefined) return;
        const name = calleeName(node);
        if (name === null) return;
        if (mutators.has(name) && frame.mutatorNode === null) {
          frame.mutatorNode = node;
        }
        if (signalCallees.has(name)) {
          frame.calledSignal = true;
        }
      },
    };
  },
});
