import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCapturePayload, captureDisclosure, captureSetting, captureStatus, sendCapture, setCapture } from '../capture.js';
import { readConsent, writeConsent } from '../consent.js';
import type { SessionFootprint } from '../footprint.js';

const GISTS: SessionFootprint[] = [
  { taskGist: 'add a retry to the uploader', model: 'claude-opus-5', turns: 4, fileCount: 3, tools: { Read: 2 }, costUsd: 0.4 },
];

describe('capture', () => {
  const home0 = process.env.HOME;
  const api0 = process.env.CC_AUDIT_API;
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-audit-capture-'));
    process.env.HOME = home; // isolates ~/.cc-audit (consent.json + install.json)
    process.env.CC_AUDIT_API = 'https://example.invalid';
  });
  afterAll(() => {
    if (home0 === undefined) delete process.env.HOME;
    else process.env.HOME = home0;
    if (api0 === undefined) delete process.env.CC_AUDIT_API;
    else process.env.CC_AUDIT_API = api0;
    rmSync(home, { recursive: true, force: true });
  });

  beforeEach(() => {
    rmSync(join(home, '.cc-audit'), { recursive: true, force: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is tri-state: unset means never asked, not opted out', () => {
    expect(captureSetting()).toBeUndefined();
    setCapture(false);
    expect(captureSetting()).toBe(false);
    setCapture(true);
    expect(captureSetting()).toBe(true);
  });

  it('records when the answer was given', () => {
    setCapture(true);
    expect(readConsent().captureAnsweredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('an opt-out survives unrelated consent writes (an upgrade must not reset it)', () => {
    setCapture(false);
    writeConsent({ localRead: true });
    expect(captureSetting()).toBe(false);
  });

  it('sends NOTHING when capture was never answered', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendCapture({ any: 'aggregate' }, GISTS)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends NOTHING when opted out', async () => {
    setCapture(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendCapture({ any: 'aggregate' }, GISTS)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs to the solo-capture endpoint once opted in', async () => {
    setCapture(true);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendCapture({ schemaVersion: 9 }, GISTS)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://example.invalid/v1/public/solo-capture');
    const body = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
    expect(body.aggregate).toEqual({ schemaVersion: 9 });
    expect(body.gists).toEqual(GISTS);
    expect(typeof body.installKey).toBe('string');
  });

  it('swallows a rejected transport rather than failing the run', async () => {
    setCapture(true);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ENOTFOUND')));
    await expect(sendCapture({}, GISTS)).resolves.toBe(false);
  });

  it('treats a non-2xx (e.g. the endpoint not existing yet) as not-sent, not an error', async () => {
    setCapture(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(sendCapture({}, GISTS)).resolves.toBe(false);
  });

  it('the payload carries only the allowlisted fields — no room for code or paths', () => {
    const payload = buildCapturePayload({ a: 1 }, GISTS);
    expect(Object.keys(payload).sort()).toEqual(['aggregate', 'gists', 'installKey', 'schemaVersion', 'sentAt']);
  });

  it('the disclosure names what is sent, what never is, retention, and the opt-out', () => {
    const text = captureDisclosure(7);
    expect(text).toContain('7 task gists');
    expect(text).toMatch(/Never sent:.*source code/i);
    expect(text).toContain('cc-audit capture --off');
    expect(text).toMatch(/Retention/);
  });

  it('status reveals the install key only when capture is on, so it can be deleted by', () => {
    setCapture(true);
    expect(captureStatus()).toContain('Install key:');
    setCapture(false);
    const off = captureStatus();
    expect(off).toContain('OFF');
    expect(off).not.toContain('Install key:');
  });
});
