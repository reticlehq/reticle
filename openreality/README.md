# @reticlehq/openreality

**The Open Verification Protocol** — a protocol for establishing machine-verifiable evidence that an intended action produced a claimed outcome in a real environment.

- **[SPEC.md](./SPEC.md)** — the normative specification.
- **[GOVERNANCE.md](./GOVERNANCE.md)** — how it changes, and the vendor conflict it does not hide.
- **`schema/`** — JSON Schema for every noun, generated from the source. Implement in any language by validating against these; you need none of this code.

## Implementing it

```bash
npm i @reticlehq/openreality
```

```ts
import { Realm } from '@reticlehq/openreality';

class MyRealm extends Realm {
  // The compiler tells you what you must answer.
  // The rules you must not break are already written, and are not yours to override.
}
```

`perform()` refuses undeclared capabilities on your behalf. There is no method that returns a verdict — a realm that could decide whether its own action succeeded would be the thing under test grading its own work, and every honest property of this protocol descends from the fact that it cannot.

## The four things that make it different from a test report

|  |  |
| --- | --- |
| **Independence** | Evidence for a consequence must not come from the channel that performed the action. The application agreeing with itself is not evidence that it acted. |
| **Grade** | A green has a price. "Something was on screen" cannot pay for it. |
| **Coverage** | The verdict states what it could _not_ see. No other verification format does. |
| **Epoch** | Evidence is bound to a round of source edits, so observations of code that has been rewritten cannot answer for the code that replaced it. |

## Verdicts

`yes` · `no` · `unknown` · `no-fault` — and the last two are the point. An implementation that turns "I could not see" into `yes` is worse than no implementation, because it costs you the one thing you came for.
