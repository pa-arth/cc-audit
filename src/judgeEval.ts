// Offline eval for the local right-sizing judge (see localJudge.ts).

import type { SessionFootprint } from './footprint.js';
import type { JudgeFn } from './localJudge.js';
import type { Tier } from './label.js';

/** One labeled case: a session, the model it actually ran on, and the true cheapest tier. */
export interface EvalCase {
  id: string;
  footprint: SessionFootprint;
  trueMinTier: Tier;
}

export interface EvalReport {
  /** Cases in the set. */
  cases: number;
  precision: number | null;
  /** Ids of the cases behind any wrong call that counts against precision. */
  falseDowngrades: string[];
  /** Cases the judge produced no usable verdict for. */
  unassessed: number;
  /** Whether the judge is good enough to ship. */
  pass: boolean;
}

/** Load labeled cases (one JSON object per line). */
export function loadEvalSet(_path: string): EvalCase[] {
  throw new Error('not implemented');
}

/** Run the judge over the cases and report how it did. */
export async function evaluateJudge(_cases: EvalCase[], _judge: JudgeFn): Promise<EvalReport> {
  throw new Error('not implemented');
}
