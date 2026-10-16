// A local right-sizing judge: the same question the hosted judge answers ("what is
// the cheapest tier that could have done this task?"), asked of a model running on
// the developer's machine through any OpenAI-compatible endpoint (Ollama, LM Studio,
// llama.cpp server). Nothing leaves the machine.
//
// Status: experimental. It is not wired into the CLI yet.

import type { SessionFootprint } from './footprint.js';
import type { Tier } from './label.js';

export interface LocalVerdict {
  minTier: Tier;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

/** Anything that judges one footprint. The local judge is one; tests pass fakes. */
export type JudgeFn = (footprint: SessionFootprint) => Promise<LocalVerdict>;

export interface LocalJudgeOptions {
  /** Base URL of an OpenAI-compatible server, e.g. http://localhost:11434/v1 */
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

const PROMPT = `You are judging Claude Code sessions. Given a task gist and metadata, reply with ONLY a JSON object:
{"minTier": "haiku" | "sonnet" | "frontier", "confidence": "high" | "medium" | "low", "reason": "<one sentence>"}
minTier is the cheapest model tier that could have done the task to the same standard.`;

export function createLocalJudge(opts: LocalJudgeOptions = {}): JudgeFn {
  const baseUrl = (opts.baseUrl ?? process.env.CC_AUDIT_LOCAL_JUDGE_URL ?? 'http://localhost:11434/v1').replace(/\/$/, '');
  const model = opts.model ?? process.env.CC_AUDIT_LOCAL_JUDGE_MODEL ?? 'qwen2.5:7b-instruct';
  const doFetch = opts.fetchImpl ?? fetch;

  return async (fp) => {
    const res = await doFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: JSON.stringify(fp) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`local judge returned ${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content ?? '';
    // Small local models wrap JSON in prose or code fences more often than not.
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`local judge reply had no JSON: ${text.slice(0, 120)}`);
    const v = JSON.parse(match[0]) as Partial<LocalVerdict>;
    if (v.minTier !== 'haiku' && v.minTier !== 'sonnet' && v.minTier !== 'frontier') {
      throw new Error(`local judge gave an unknown tier: ${String(v.minTier)}`);
    }
    return { minTier: v.minTier, confidence: v.confidence ?? 'low', reason: v.reason ?? '' };
  };
}
