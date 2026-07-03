import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findLiveTranscript, projectDirSlug } from '../adapters/claudeCode.js';
import { renderStatuslineLabel } from '../statusline.js';

describe('renderStatuslineLabel (the claude-hud extra-cmd label)', () => {
  it('empty label when the live ctx is undiscoverable (claude-hud renders nothing)', () => {
    expect(renderStatuslineLabel({ liveCtx: null, onsetTokens: 100_000, boundary: false })).toBe('');
  });

  it('a plain ctx gauge when there is no trustworthy personal knee yet', () => {
    // onsetTokens null ⇒ never emit a threshold-flavored line — just the gauge.
    expect(renderStatuslineLabel({ liveCtx: 82_000, onsetTokens: null, boundary: true })).toBe('ctx 82k');
  });

  it('a plain ctx gauge below the knee', () => {
    expect(renderStatuslineLabel({ liveCtx: 60_000, onsetTokens: 100_000, boundary: false })).toBe('ctx 60k');
  });

  it('SOFT warn past the knee with no boundary (one coherent thread)', () => {
    expect(renderStatuslineLabel({ liveCtx: 150_000, onsetTokens: 100_000, boundary: false })).toBe(
      '⚠ past your knee · 150k',
    );
  });

  it('HARD compact-now at a boundary while armed', () => {
    expect(renderStatuslineLabel({ liveCtx: 180_000, onsetTokens: 100_000, boundary: true })).toBe(
      '✂ compact now · 180k',
    );
  });

  it('every label stays within claude-hud\'s 50-char budget', () => {
    for (const boundary of [true, false]) {
      const label = renderStatuslineLabel({ liveCtx: 1_234_000, onsetTokens: 50_000, boundary });
      expect(label.length).toBeLessThanOrEqual(50);
    }
  });
});

describe('findLiveTranscript (self-discovery from cwd)', () => {
  it('encodes the cwd to Claude Code\'s project slug (every non-alphanumeric → dash)', () => {
    expect(projectDirSlug('/Users/x/repo/.claude/wt')).toBe('-Users-x-repo--claude-wt');
  });

  it('returns the newest-mtime transcript under the encoded project dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'ccaudit-live-'));
    const cwd = '/Users/demo/proj';
    const dir = join(root, projectDirSlug(cwd));
    mkdirSync(dir, { recursive: true });
    const older = join(dir, 'older.jsonl');
    const newer = join(dir, 'newer.jsonl');
    writeFileSync(older, '{}\n');
    writeFileSync(newer, '{}\n');
    utimesSync(older, new Date(1_000_000), new Date(1_000_000));
    utimesSync(newer, new Date(2_000_000), new Date(2_000_000));
    expect(findLiveTranscript(cwd, root)).toBe(newer);
  });

  it('returns null when the project dir has no transcripts', () => {
    const root = mkdtempSync(join(tmpdir(), 'ccaudit-empty-'));
    expect(findLiveTranscript('/Users/demo/nothing', root)).toBeNull();
  });
});
