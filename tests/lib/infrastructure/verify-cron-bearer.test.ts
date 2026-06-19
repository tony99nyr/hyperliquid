import { describe, it, expect } from 'vitest';
import { verifyCronBearer } from '@/lib/infrastructure/auth/auth';
import type { NextRequest } from 'next/server';

function req(auth?: string): NextRequest {
  return {
    headers: { get: (k: string) => (k.toLowerCase() === 'authorization' ? (auth ?? null) : null) },
  } as unknown as NextRequest;
}

describe('verifyCronBearer — the gate between the internet and the autonomous order-placer', () => {
  it('false when the secret is unset (even with a matching-looking header)', () => {
    expect(verifyCronBearer(req('Bearer anything'), undefined)).toBe(false);
  });
  it('false when the Authorization header is absent', () => {
    expect(verifyCronBearer(req(undefined), 'sek')).toBe(false);
  });
  it('false on the wrong scheme', () => {
    expect(verifyCronBearer(req('Basic sek'), 'sek')).toBe(false);
  });
  it('false on the wrong token', () => {
    expect(verifyCronBearer(req('Bearer nope'), 'sek')).toBe(false);
  });
  it('false on a different-length token without throwing (the length guard)', () => {
    expect(verifyCronBearer(req('Bearer short'), 'a-much-longer-secret-value')).toBe(false);
  });
  it('false on an empty token', () => {
    expect(verifyCronBearer(req('Bearer '), 'sek')).toBe(false);
  });
  it('true on an exact match (case-insensitive scheme, surrounding whitespace tolerated)', () => {
    expect(verifyCronBearer(req('Bearer sek'), 'sek')).toBe(true);
    expect(verifyCronBearer(req('  bearer sek  '), 'sek')).toBe(true);
  });
});
