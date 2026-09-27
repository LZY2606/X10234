import { describe, it, expect } from 'vitest';
describe('env', () => {
  it('crypto works', async () => {
    const data = new TextEncoder().encode('a');
    const buf = await crypto.subtle.digest('SHA-256', data);
    const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex.slice(0, 8)).toBe('ca978112');
  });
});
