import { describe, expect, it } from 'vitest';
import { RiskSeverity, RiskSurface, RunChangeKind } from '@reticle/protocol';
import { buildRisks, classifyChangedFiles, risksForPath } from './risk-classify.js';

describe('risksForPath', () => {
  it('tags auth, payment, secrets, destructive, and db/migration paths', () => {
    expect(risksForPath('src/auth/login.ts')).toContain(RiskSurface.AUTH);
    expect(risksForPath('src/checkout/PayButton.tsx')).toContain(RiskSurface.PAYMENT);
    expect(risksForPath('.env.production')).toContain(RiskSurface.SECRETS);
    expect(risksForPath('src/api/deleteAccount.ts')).toContain(RiskSurface.DESTRUCTIVE);
    const migration = risksForPath('prisma/migrations/001_init.sql');
    expect(migration).toContain(RiskSurface.MIGRATION);
    expect(migration).toContain(RiskSurface.DB);
  });

  it('returns no surfaces for an innocuous path', () => {
    expect(risksForPath('src/components/Button.tsx')).toEqual([]);
  });
});

describe('classifyChangedFiles + buildRisks', () => {
  const files = [
    { path: 'src/checkout/PayButton.tsx', changeKind: RunChangeKind.MODIFIED },
    { path: 'src/checkout/charge.ts', changeKind: RunChangeKind.ADDED },
    { path: 'src/components/Button.tsx', changeKind: RunChangeKind.MODIFIED },
  ];

  it('classifies each file and dedupes surfaces into one risk row each', () => {
    const classified = classifyChangedFiles(files);
    expect(classified[0]?.risk).toContain(RiskSurface.PAYMENT);
    const risks = buildRisks(classified);
    const payment = risks.filter((r) => r.surface === RiskSurface.PAYMENT);
    expect(payment).toHaveLength(1);
    expect(payment[0]?.severity).toBe(RiskSeverity.CRITICAL);
    expect(payment[0]?.gated).toBe(false);
  });

  it('marks a surface gated when the policy requires confirmation', () => {
    const risks = buildRisks(classifyChangedFiles(files), {
      requiresConfirmation: [RiskSurface.PAYMENT],
    });
    expect(risks.find((r) => r.surface === RiskSurface.PAYMENT)?.gated).toBe(true);
  });
});
