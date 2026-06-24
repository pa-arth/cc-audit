import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn(() => ({ unref: vi.fn() })));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { machineAnonId, openURL } from '../open.js';
import { postReport } from '../judgeClient.js';

describe('machineAnonId', () => {
  it('is a stable 16-char hex hash (no raw hostname/path)', () => {
    const a = machineAnonId();
    const b = machineAnonId();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('openURL', () => {
  afterEach(() => spawnMock.mockClear());
  it('spawns a platform opener with the url and never throws', () => {
    expect(() => openURL('https://promptster.ai/cost-report/abc')).not.toThrow();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0]!;
    expect((args as string[]).join(' ')).toContain('https://promptster.ai/cost-report/abc');
  });
});

describe('postReport', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs the body and returns id + url', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'abc123xyz789', url: 'https://promptster.ai/cost-report/abc123xyz789' }) }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await postReport({ aggregate: { schemaVersion: 1, tool: 'claude_code' } }, 'http://localhost:3001');
    expect(r.id).toBe('abc123xyz789');
    expect(r.url).toContain('/cost-report/');
    const [u, opts] = fetchMock.mock.calls[0]!;
    expect(u).toBe('http://localhost:3001/v1/public/cost-audit-report');
    expect((opts as { method: string }).method).toBe('POST');
  });

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => 'at capacity' })));
    await expect(postReport({ aggregate: {} }, 'http://localhost:3001')).rejects.toThrow(/503/);
  });
});
