// Compact-boundary detection over the LIVE session — the "FIRE" half of the live-guardrail
// two-part trigger. A compact boundary requires BOTH signals (either alone is too weak):
//   - topic shift:   the latest prompt's content words barely overlap the recent prompt
//                    thread (content-word Jaccard < 0.2 vs the last ~3 meaningful prompts).
//   - file rotation: the file working set fully rotated across that prompt (≥2 distinct
//                    files each side, zero overlap) — reuses contextHygiene.workingSetRotated
//                    (its staleSwitches "new idea, didn't /clear" detector).
// At a boundary the prior thread's context went dead, so a /compact sheds nothing the
// current work still needs — the moment it makes sense to RUN the command (HARD line).
// No boundary while armed = one coherent thread, so the statusline stays SOFT.
//
// Ported from the backend's detectThreadBoundaries / detectCompactBoundaries (same
// constants) so cc-audit and the backend agree on where a thread ends.

import type { Session, Span } from './model.js';
import { workingSetRotated } from './contextHygiene.js';

const TOPIC_SHIFT_MIN_WORDS = 8; // a prompt below this is too short to judge a topic shift
const TOPIC_SHIFT_MAX_OVERLAP = 0.2; // content-word Jaccard below this = a new topic
const TOPIC_SHIFT_WINDOW = 3; // meaningful prompts of recent thread to compare against
const TOPIC_STOPWORDS = new Set(
  ('this that these those with have having from what when where which while should would could ' +
    'please thing things just like want need will make sure dont doesnt cant wont lets also then ' +
    'than them they your their about there here some more very really still again right good okay ' +
    'test tests testing file files code change changes changed update updated working works error ' +
    'errors issue issues problem check look fix fixes fixed bugs implement implementation').split(' '),
);

/** Content words of a prompt (≥4 chars, non-stopword) — the topic fingerprint. */
function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')) {
    if (w.length >= 4 && !TOPIC_STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

/** Own-chain spans that opened with a genuine typed prompt (firstUserText populated by the
 *  adapter's isGenuinePrompt gate). One prompt = one thread candidate. */
function meaningfulSpans(session: Session): Span[] {
  return session.spans.filter((s) => !s.isSidechain && s.firstUserText.trim().length > 0);
}

/** Does the LATEST prompt shift topic vs the recent prompt thread? Content-word overlap
 *  with the previous TOPIC_SHIFT_WINDOW meaningful prompts drops below the threshold. */
function latestPromptShiftsTopic(spans: Span[]): boolean {
  if (spans.length < 2) return false;
  const words = contentWords(spans[spans.length - 1]!.firstUserText);
  if (words.size < TOPIC_SHIFT_MIN_WORDS) return false;
  const recent = new Set<string>();
  for (let j = Math.max(0, spans.length - 1 - TOPIC_SHIFT_WINDOW); j < spans.length - 1; j++) {
    for (const w of contentWords(spans[j]!.firstUserText)) recent.add(w);
  }
  if (recent.size === 0) return false;
  let shared = 0;
  for (const w of words) if (recent.has(w)) shared++;
  return shared / words.size < TOPIC_SHIFT_MAX_OVERLAP;
}

/**
 * Is the MOST RECENT prompt in the live session a compact boundary — i.e. did BOTH the
 * topic shift AND the file working set rotate across it? True ⇒ the statusline fires the
 * HARD "compact now — thread boundary" line; false ⇒ stay soft (one coherent thread, or
 * a new thread that hasn't rotated its files yet).
 */
export function detectLiveBoundary(session: Session): boolean {
  const spans = meaningfulSpans(session);
  if (!latestPromptShiftsTopic(spans)) return false;

  // File rotation across the last prompt: its first own-chain turn is the boundary index
  // in the flattened own-chain turn stream.
  const ownSpans = session.spans.filter((s) => !s.isSidechain);
  const ownTurns = ownSpans.flatMap((s) => s.turns);
  const last = spans[spans.length - 1]!;
  let boundary = 0;
  for (const s of ownSpans) {
    if (s === last) break;
    boundary += s.turns.length;
  }
  return workingSetRotated(ownTurns, boundary);
}
