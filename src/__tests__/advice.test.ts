import { describe, expect, it } from 'vitest';
import { parseAdvice } from '../advice.js';

/** Verbatim header/closing lines from a real `claude -p` run against a live corpus
 *  (2026-07-28). If the parser can't handle THIS, it can't handle anything. */
const REAL = `**Plan 1 — Stop letting sessions run to the context wall; compact and clear on purpose, not on autopilot**

Evidence: \`contextHygiene.avoidableTotalUsdPerMonth\` is $6,095.81/mo — $4,713.16/mo from compaction (\`avoidableCompactUsdPerMonth\`, across \`autoCompactions\` = 213 and \`sessionsRunToWall\` = 91).

The change: when you finish a task, \`/clear\` before starting the next one.

Worth: up to $6,095.81/mo by the record's own "avoidable" accounting.

How you'll know: \`autoCompactions\` (213) goes down.

**Plan 2 — Route the delegation fleet off Opus; you are paying premium for 22,580 subagent turns**

Evidence: \`spend.subagentShare\` is 0.2026 of spend.

Worth: not quantified.

**Plan 3 — Fix your one dominant custom command: it's a context hog running 24.6 turns a shot**

Evidence: \`custom-4122cf6a\` costs $376.18/mo over 81.85 invocations/mo.

**Next session: \`/clear\` between tasks instead of continuing the same session into a new topic — that one habit is aimed at the $1,382.65/mo of stale carry and the 1,032 switches behind it.**`;

describe('parseAdvice', () => {
  it('parses the real thing', () => {
    const a = parseAdvice('claude', REAL);
    expect(a.plans).toHaveLength(3);
    expect(a.plans!.map((p) => p.n)).toEqual([1, 2, 3]);
    expect(a.plans![0]!.title).toBe(
      'Stop letting sessions run to the context wall; compact and clear on purpose, not on autopilot',
    );
    expect(a.plans![1]!.title).toContain('Route the delegation fleet off Opus');
  });

  it('keeps each plan body with its own plan and nothing else', () => {
    const a = parseAdvice('claude', REAL);
    expect(a.plans![0]!.body).toContain('avoidableCompactUsdPerMonth');
    expect(a.plans![0]!.body).not.toContain('subagentShare');
    expect(a.plans![1]!.body).toContain('subagentShare');
    expect(a.plans![1]!.body).not.toContain('custom-4122cf6a');
  });

  it('pulls the closing line out and does not leave it duplicated in the last plan', () => {
    const a = parseAdvice('claude', REAL);
    expect(a.closing).toContain('/clear` between tasks');
    expect(a.plans![2]!.body).not.toContain('Next session');
  });

  it('ALWAYS keeps the raw text — the render never depends on the parse', () => {
    for (const text of [REAL, 'just some unstructured prose about your usage', '']) {
      expect(parseAdvice('claude', text).raw).toBe(text.trim());
    }
  });

  it('returns null plans rather than inventing boundaries when the shape is unfamiliar', () => {
    const a = parseAdvice('codex', 'Here is one long paragraph of advice with no headers at all.');
    expect(a.plans).toBeNull();
    expect(a.raw).toContain('one long paragraph');
  });

  it('does not create a phantom plan from a mid-sentence mention', () => {
    const a = parseAdvice('claude', 'You should plan 2 sessions ahead. Also plan 3 refactors.');
    expect(a.plans).toBeNull();
  });

  it('tolerates heading and colon variants a future model might emit', () => {
    const md = ['## Plan 1: Cut carry', 'body one', '', '## Plan 2: Pin models', 'body two'].join('\n');
    const a = parseAdvice('codex', md);
    expect(a.plans).toHaveLength(2);
    expect(a.plans![0]!.title).toBe('Cut carry');
    expect(a.plans![1]!.body).toBe('body two');
  });

  it('handles empty output without throwing', () => {
    const a = parseAdvice('claude', '   ');
    expect(a).toEqual({ agent: 'claude', raw: '', plans: null, closing: null });
  });

  it('records which agent wrote it, so the report can attribute honestly', () => {
    expect(parseAdvice('codex', REAL).agent).toBe('codex');
  });
});
