// The injected turn-1 prefix, measured from the transcript instead of censused from disk.
//
// WHY THIS MODULE EXISTS. The always-on breakdown used to answer "what did you put in
// your context" by walking files under ~/.claude. The context is not assembled from
// disk — Claude Code assembles it and records it, itemised, as typed `attachment` rows
// ahead of the first assistant turn. A disk census therefore has NO SUBSCRIBER to a
// Claude Code release: built-in skills ship inside the binary and are never on disk, the
// agent listing and deferred-tool delta move when the tool updates, and nothing in
// ~/.claude moves with them. Measured on 501 local sessions, the census reported the
// skill listing at 967 tokens against a measured median of ~5,680 — and it was wrong in
// BOTH directions, because it never read `skillOverrides` and so billed six switched-off
// skills every turn.
//
// The disk census is retained, but demoted: it ATTRIBUTES a measured block to the user's
// files (which skill contributed which slice). It no longer decides how big the block is.
//
// THE FIELD PER KIND IS NOT THE ENVELOPE. Each attachment carries its injected text in a
// different field — `content`, `addedLines`, `addedBlocks`, `snippet`. Sizing
// JSON.stringify(attachment) over-reports (11,313 vs 10,564 ch on one skill_listing) and
// silently prices JSON punctuation as user config.

import { countTokens } from './configFiles.js';

/** The measured component a kind feeds. `null` ⇒ residual (see UNMAPPED, below). */
export type InjectedComponent = 'skill' | 'hook' | 'mcp' | 'deferred' | 'agent';

/** Kind → the field(s) carrying the text that was actually injected.
 *
 *  Discovered by censusing every string/string[] field of every kind across the local
 *  corpus, NOT by reading documentation — the mapping is a wire fact and the vendor is
 *  free to change it. A kind absent here is sized generically (see `attachmentTokens`),
 *  so a new kind is over-counted at worst, never silently dropped. */
const INJECTED_FIELDS: Record<string, readonly string[]> = {
  skill_listing: ['content'],
  hook_success: ['content'],
  hook_additional_context: ['content'],
  hook_system_message: ['content'],
  mcp_instructions_delta: ['addedBlocks'],
  deferred_tools_delta: ['addedLines'],
  agent_listing_delta: ['addedLines'],
};

/** Kinds that are KNOWN to inject nothing, as distinct from kinds we cannot size.
 *
 *  `hook_cancelled` carries only ids and a command; `auto_mode` carries no fields at all.
 *  Routing them to the residual would make the residual grow for blocks that cost zero,
 *  which is exactly the signal the residual exists to carry (a vendor added a kind we
 *  don't understand). Known-zero and unknown-size must not share a bucket. */
const ZERO_INJECTION: Record<string, InjectedComponent | 'none'> = {
  hook_cancelled: 'hook',
  auto_mode: 'none',
};

const KIND_COMPONENT: Record<string, InjectedComponent> = {
  skill_listing: 'skill',
  hook_success: 'hook',
  hook_additional_context: 'hook',
  hook_system_message: 'hook',
  mcp_instructions_delta: 'mcp',
  deferred_tools_delta: 'deferred',
  agent_listing_delta: 'agent',
};

/** Per-session measurement of the blocks Claude Code injected ahead of turn 1. */
export interface InjectedPrefix {
  skillListingTokens: number;
  hookOutputTokens: number;
  mcpInstructionTokens: number;
  deferredToolTokens: number;
  agentListingTokens: number;
  /** Kinds with no field of their own — sized, named, never dropped. */
  otherInjectedTokens: number;
  otherInjectedKinds: string[];

  /** hookName → tokens this session. LOCAL-ONLY; hook names are user-authored.
   *
   *  Hook output is the most actionable line in the whole breakdown — entirely
   *  user-written, entirely removable — and "you carry 950 tokens of hook output" is only
   *  actionable once it says WHICH hook. The attachment stamps `hookName` itself, so this
   *  is read off the wire rather than guessed by matching settings.json matchers. */
  hookTokensByName: Record<string, number>;

  /** Skill names the listing actually carried. THE authoritative membership list:
   *  a skill on disk and absent from here did not load, whatever the directory says. */
  skillNames: string[];
  /** The listing's own `skillCount`, when it declared one. null ⇒ no listing seen. */
  listingSkillCount: number | null;

  /** Tokens of every main-chain user row ahead of turn 1 — the prompt AND the
   *  system-reminder blocks riding with it, which is where CLAUDE.md and auto-memory
   *  are actually injected. Counted as one term because it entered the prefix as one;
   *  the memory fields attribute INSIDE it rather than adding to it (see alwaysOn.ts). */
  userMessageTokens: number;

  /** input + both cache-write buckets + cache-read on the first main-chain turn.
   *  null ⇒ no main-chain turn, so nothing here reconciles and the session is skipped. */
  measuredPrefixTokens: number | null;

  /** A `deferred_tools_delta` was present ⇒ MCP tools were tool-search-deferred in the
   *  session AS IT RAN. Replaces inferring it from the auditing process's own env. */
  sawDeferredTools: boolean;

  /** Did this session record ANY first-turn attachment?
   *
   *  Without this, `sawDeferredTools: false` conflates two opposite meanings: "this
   *  session ran with tool search OFF" and "this transcript predates attachment records,
   *  so we never got to ask". A transcript with no attachments at all is not evidence
   *  about deferral, and counting it as evidence-against is the zero-means-unknown trap
   *  in miniature. Only sessions with `sawAnyAttachment` vote. */
  sawAnyAttachment: boolean;

  /** Did the turn whose usage the prefix is measured from also END this collection?
   *
   *  On a RESUMED transcript it does not. The turn-1 row is a replay owned by an earlier
   *  file, so it closes collection and is then dropped by the cross-file `seen` dedup,
   *  leaving `firstMain` on a later turn whose cacheRead has the entire replayed
   *  conversation folded in. Pairing the two does not error — it gives a turn-1-sized
   *  `attributed` against a much larger `measured`, which INFLATES `fixedPrefixTokens`.
   *  `reconcile()` cannot catch that: it only fires on a NEGATIVE remainder, so
   *  inflation is the silent direction and the wrong number looks entirely plausible.
   *
   *  False ⇒ excluded from the component medians rather than contributing a mismatched
   *  pair. This costs nothing on the observed side: `standingContextTokens` keeps using
   *  that turn as it always has, because a resumed prefix genuinely IS what that turn
   *  carried. The unanswerable question is only the BREAKDOWN. */
  prefixTurnIsFirst: boolean;
}

export function emptyInjectedPrefix(): InjectedPrefix {
  return {
    skillListingTokens: 0,
    hookOutputTokens: 0,
    mcpInstructionTokens: 0,
    deferredToolTokens: 0,
    agentListingTokens: 0,
    otherInjectedTokens: 0,
    otherInjectedKinds: [],
    hookTokensByName: {},
    skillNames: [],
    listingSkillCount: null,
    userMessageTokens: 0,
    measuredPrefixTokens: null,
    sawDeferredTools: false,
    sawAnyAttachment: false,
    prefixTurnIsFirst: false,
  };
}

/** Text of one attachment, in tokens.
 *
 *  A mapped kind is sized on its known field. An UNMAPPED kind is sized by summing every
 *  string / string[] field except `type` — deliberately generous. The failure this module
 *  exists to survive is a vendor release adding a kind, and a residual that reads zero for
 *  an unrecognised block is indistinguishable from no block at all. */
export function attachmentTokens(att: Record<string, unknown>): number {
  const kind = typeof att.type === 'string' ? att.type : '';
  if (kind in ZERO_INJECTION) return 0;
  const fields = INJECTED_FIELDS[kind];
  const keys = fields ?? Object.keys(att).filter((k) => k !== 'type');
  let text = '';
  for (const k of keys) {
    const v = att[k];
    if (typeof v === 'string') text += v;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) text += (v as string[]).join('\n');
  }
  return countTokens(text);
}

/** Fold one first-turn attachment into the running measurement. */
export function foldAttachment(acc: InjectedPrefix, att: Record<string, unknown>): void {
  const kind = typeof att.type === 'string' ? att.type : '';
  if (!kind) return;
  acc.sawAnyAttachment = true;

  if (kind === 'skill_listing') {
    if (Array.isArray(att.names)) {
      for (const n of att.names) if (typeof n === 'string') acc.skillNames.push(n);
    }
    if (typeof att.skillCount === 'number') acc.listingSkillCount = att.skillCount;
  }
  if (kind === 'deferred_tools_delta') acc.sawDeferredTools = true;

  const tokens = attachmentTokens(att);
  if (kind.startsWith('hook_') && tokens > 0) {
    const name = typeof att.hookName === 'string' && att.hookName ? att.hookName : '(unnamed hook)';
    acc.hookTokensByName[name] = (acc.hookTokensByName[name] ?? 0) + tokens;
  }
  const zero = ZERO_INJECTION[kind];
  const component = zero && zero !== 'none' ? zero : zero === 'none' ? null : KIND_COMPONENT[kind];

  switch (component) {
    case 'skill':
      acc.skillListingTokens += tokens;
      return;
    case 'hook':
      acc.hookOutputTokens += tokens;
      return;
    case 'mcp':
      acc.mcpInstructionTokens += tokens;
      return;
    case 'deferred':
      acc.deferredToolTokens += tokens;
      return;
    case 'agent':
      acc.agentListingTokens += tokens;
      return;
    default:
      // Known-zero kinds ('none') fall here too, but contribute 0 tokens and are still
      // named — a reader can see the kind was recognised rather than wonder if it was
      // dropped.
      acc.otherInjectedTokens += tokens;
      if (!acc.otherInjectedKinds.includes(kind)) acc.otherInjectedKinds.push(kind);
  }
}

/** Sum of the named component fields (excluding the residual and the user message). */
export function namedComponentTokens(p: InjectedPrefix): number {
  return (
    p.skillListingTokens +
    p.hookOutputTokens +
    p.mcpInstructionTokens +
    p.deferredToolTokens +
    p.agentListingTokens
  );
}

/** Everything the transcript attributes: named components + residual + user message. */
export function attributedTokens(p: InjectedPrefix): number {
  return namedComponentTokens(p) + p.otherInjectedTokens + p.userMessageTokens;
}

/** The remainder — system prompt + tool schemas. Genuinely not the user's to cut, and
 *  worth naming for exactly that reason: without it the breakdown reads as "delete all
 *  of this" when ~85% of the floor is the vendor's.
 *
 *  Returns null when there is no measured prefix to reconcile against. NEGATIVE values
 *  are returned as-is and NOT clamped: a negative remainder means a component is double
 *  counted or the prefix formula has drifted from the vendor's, and clamping is how that
 *  class of defect hides — the number stays plausible while the model underneath is
 *  wrong. Callers surface it; see `reconcile`. */
export function fixedPrefixTokens(p: InjectedPrefix): number | null {
  if (p.measuredPrefixTokens == null) return null;
  return p.measuredPrefixTokens - attributedTokens(p);
}

export interface ReconciliationFailure {
  sessionId: string;
  measuredPrefixTokens: number;
  attributedTokens: number;
  fixedPrefixTokens: number;
  /** The component sizes, so a failure report names the suspect rather than a total. */
  components: Record<string, number>;
}

/** Per-session reconciliation check. A session whose components exceed its measured
 *  prefix is returned as a failure; callers decide whether to abort or surface it, but
 *  NOTHING may silently clamp it to zero. */
export function reconcile(sessionId: string, p: InjectedPrefix): ReconciliationFailure | null {
  const fixed = fixedPrefixTokens(p);
  if (fixed == null || fixed >= 0) return null;
  return {
    sessionId,
    measuredPrefixTokens: p.measuredPrefixTokens!,
    attributedTokens: attributedTokens(p),
    fixedPrefixTokens: fixed,
    components: {
      skillListing: p.skillListingTokens,
      hookOutput: p.hookOutputTokens,
      mcpInstruction: p.mcpInstructionTokens,
      deferredTool: p.deferredToolTokens,
      agentListing: p.agentListingTokens,
      otherInjected: p.otherInjectedTokens,
      userMessage: p.userMessageTokens,
    },
  };
}
