import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyShareLinkAnswer,
  buildCapturePayload,
  captureDisclosure,
  captureSetting,
  captureStatus,
  RETENTION_COPY,
  sendCapture,
  setCapture,
} from '../capture.js';
import { AggregateRecordSchema } from '../aggregate.js';
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
    expect(text).toMatch(/Never read from disk:.*source code/i);
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

  it('status hands over a WORKING deletion command, not an email address', () => {
    setCapture(true);
    const status = captureStatus();
    expect(status).toContain('curl -X DELETE https://example.invalid/v1/public/solo/data');
    expect(status).toContain('"installKey"');
    expect(status).not.toMatch(/email .*@/i);
  });

  describe('the shareable-link answer is the ONLY thing that turns sharing on', () => {
    it('yes turns it on and persists it', () => {
      applyShareLinkAnswer(true);
      expect(captureSetting()).toBe(true);
      expect(readConsent().captureAnsweredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('no does NOT record an opt-out — declining a public URL is a different decision', () => {
      // If this wrote `capture: false`, the tri-state would be consumed and we could never
      // ask again, having recorded a decision the developer did not make.
      applyShareLinkAnswer(false);
      expect(captureSetting()).toBeUndefined();
    });

    it('no does NOT revoke a previous yes', () => {
      setCapture(true);
      applyShareLinkAnswer(false);
      expect(captureSetting()).toBe(true); // they still share; they just didn't want THIS link
    });

    it('no does not resurrect a previous opt-out either — off stays off', () => {
      setCapture(false);
      applyShareLinkAnswer(false);
      expect(captureSetting()).toBe(false);
    });
  });

  it('reads as the disclaimer half of the link question — it must carry itself', () => {
    // There is no longer a confirm of its own beneath this text: sharing rides on the
    // shareable-link answer. So the paragraph has to say, unprompted, that saying yes
    // turns sharing ON and that it STAYS on. Copy that only describes what is sent — with
    // no statement that a decision is being made — would leave the user opted in by a
    // question they read as being about a URL.
    const text = captureDisclosure(4);
    expect(text).toMatch(/also switches on data sharing/i);
    expect(text).toMatch(/stays on for future runs/i);
    expect(text).toContain('cc-audit capture --off');
  });

  it('does NOT claim the aggregate is dollar-free — it carries raw USD, and says so', () => {
    // Regression, and the ugly kind: the disclosure used to read "shares, counts, ratios
    // — never raw dollar amounts". The aggregate has ALWAYS carried spend.perMonthUsd,
    // spend.totalUsd, fluency.carryUsd and friends as plain numbers. A false reassurance
    // in a privacy disclosure is worse than no disclosure, because it is the sentence
    // someone relies on when deciding to say yes.
    //
    // Coupled to the schema on purpose: if a USD field is ever genuinely removed from the
    // aggregate, this test stops demanding the disclosure mention dollars. Copy alone
    // would just drift again.
    const usdFields = Object.keys(AggregateRecordSchema.shape.spend.shape).filter((k) => k.endsWith('Usd'));
    expect(usdFields.length).toBeGreaterThan(0); // the premise: raw dollars are in there

    const text = captureDisclosure(3);
    expect(text).not.toMatch(/never raw dollar/i);
    expect(text).not.toMatch(/no raw \$/i);
    // Affirmative, not merely silent — omitting the lie is not the same as disclosing.
    // \s+ because the copy is hard-wrapped and "in dollars" straddles a line break.
    expect(text).toMatch(/in\s+dollars/i);
  });

  it('does NOT promise gists are free of paths and repo names — nothing strips them', () => {
    // Second copy overreach of the same family as the dollar one. The disclosure said
    // "Never sent: your source code, diffs, file paths, or repo names". The first two are
    // enforced at ingestion. The last two were never enforced anywhere: a gist is the
    // developer's prompt VERBATIM and footprint.ts applies no redaction, so a path or repo
    // name they typed ships with it. Measured on a real 30-day corpus, 3 of 25 gists
    // carried a repo name ("add CI to cc-audit").
    //
    // Proven here, not asserted: push a prompt containing both through buildCapturePayload
    // and confirm they survive to the wire. That is the fact the copy has to match.
    const typed = 'fix the retry in src/upload/client.ts for the cc-audit repo';
    const payload = buildCapturePayload({}, [{ ...GISTS[0]!, taskGist: typed }]);
    expect(payload.gists[0]!.taskGist).toBe(typed); // verbatim — no scrub between here and the POST
    expect(payload.gists[0]!.taskGist).toContain('src/upload/client.ts');
    expect(payload.gists[0]!.taskGist).toContain('cc-audit');

    const text = captureDisclosure(3);
    expect(text).not.toMatch(/never sent:[^\n]*file paths/i);
    expect(text).not.toMatch(/never sent:[^\n]*repo names/i);
    expect(text).toMatch(/verbatim/i); // it must say the gist is unedited
  });

  it('states the retention the backend actually performs (90d scrub), not an indefinite one', () => {
    // publicSoloScrub de-identifies solo_captures on a 90-day window. Copy that reads as
    // "we keep it until you ask" would be a false statement in a privacy disclosure.
    expect(RETENTION_COPY).toContain('90 days');
    expect(captureDisclosure(3)).toContain('90 days');
  });
});
