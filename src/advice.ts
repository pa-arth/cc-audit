// The agent's written plans, packaged for the shareable report.
//
// This text is FREE-FORM. It comes out of the developer's own `claude -p` / `codex exec`,
// and while `agentRun.ts`'s prompt asks for a specific shape, a model is not a formatter
// and a future model will drift. So the contract here is deliberately lopsided:
//
//   - `raw` is ALWAYS present and is the source of truth. The renderer can display it as
//     markdown and be correct no matter what.
//   - `plans` / `closing` are a BEST-EFFORT parse, and null when the text does not clearly
//     match. Null means "render the raw text", not "something went wrong".
//
// Never make the render depend on the parse succeeding. The failure mode of a strict
// parser here is a blank report card, which is worse than an unstyled one.
//
// PRIVACY: this text quotes the developer's real numbers — dollar figures, command names,
// subagent and skill names. That is MORE than the privacy-safe aggregate carries, so it
// only ever rides on the explicit shareable-link consent, and the disclosure at that
// prompt says so in as many words.

export interface AdvicePlan {
  n: number;
  title: string;
  body: string;
}

export interface SharedAdvice {
  /** Which agent wrote it, so the report can attribute it honestly. */
  agent: string;
  /** The verbatim text. Always present; the renderer's fallback and source of truth. */
  raw: string;
  /** Best-effort structure, or null when the text didn't parse cleanly. */
  plans: AdvicePlan[] | null;
  /** The closing one-liner ("next session, do X"), when we could find it. */
  closing: string | null;
}

// Tolerant on purpose: optional bold markers, any dash, an optional trailing colon.
// Anchored to line start so a mid-sentence "plan 2" can't create a phantom section.
const PLAN_RE = /^\s*(?:\*{0,2}|#{1,4}\s*)Plan\s+(\d+)\s*[—–:-]\s*(.+?)\s*\*{0,2}\s*$/gim;
const CLOSING_RE = /^\s*\*{0,2}(?:Next session|Next time|Start here)\b[:\s—–-]*(.+?)\s*\*{0,2}\s*$/im;

function stripMarkers(s: string): string {
  return s.replace(/\*{2,}/g, '').trim();
}

/**
 * Try to split the agent's prose into its three plans. Returns nulls rather than throwing
 * or guessing — a partial parse that invents a plan boundary is worse than no parse.
 */
export function parseAdvice(agent: string, raw: string): SharedAdvice {
  const text = raw.trim();
  const base: SharedAdvice = { agent, raw: text, plans: null, closing: null };
  if (!text) return base;

  const closingMatch = text.match(CLOSING_RE);
  const closing = closingMatch ? stripMarkers(closingMatch[1]!) : null;

  const marks: Array<{ n: number; title: string; start: number; end: number }> = [];
  PLAN_RE.lastIndex = 0;
  for (let m = PLAN_RE.exec(text); m !== null; m = PLAN_RE.exec(text)) {
    marks.push({
      n: Number.parseInt(m[1]!, 10),
      title: stripMarkers(m[2]!),
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  // Fewer than two headers means the model wrote prose we can't safely cut up. The raw
  // text still renders fine — that is the whole point of keeping it.
  if (marks.length < 2) return { ...base, closing };

  const plans: AdvicePlan[] = marks.map((mark, i) => {
    const bodyEnd = i + 1 < marks.length ? marks[i + 1]!.start : text.length;
    let body = text.slice(mark.end, bodyEnd).trim();
    // Don't duplicate the closing line into the last plan's body.
    if (closingMatch && i === marks.length - 1) {
      const idx = body.lastIndexOf(closingMatch[0].trim());
      if (idx >= 0) body = body.slice(0, idx).trim();
    }
    return { n: mark.n, title: mark.title, body };
  });

  return { agent, raw: text, plans, closing };
}
