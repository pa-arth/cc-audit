// Terminal theming for the audit report, modeled on Promptster's brand: warm
// orange/gold accents over high-contrast neutrals, with emerald/amber/red status
// colors. Truecolor ANSI is emitted only to an interactive TTY — when output is
// piped, redirected, NO_COLOR is set, or we're under a test runner, every helper
// is an identity function, so the report stays plain text (and assertions on it
// keep matching). This is the only place that knows about escape codes.

const ESC = String.fromCharCode(27); // ESC (0x1B) — kept out of source as a literal

// Color is on for an interactive truecolor TTY, off when piped/redirected. Two
// standard overrides bracket that default: NO_COLOR (any value) forces it OFF
// (no-color.org), and FORCE_COLOR (anything but "0") forces it ON — the escape
// hatch for IDE terminals, pagers, or agent contexts that don't report a TTY.
// NO_COLOR wins if somehow both are set.
const forceColor = Boolean(process.env.FORCE_COLOR) && process.env.FORCE_COLOR !== '0';
const colorEnabled = process.env.NO_COLOR
  ? false
  : forceColor || (Boolean(process.stdout && process.stdout.isTTY) && process.env.TERM !== 'dumb');

type Style = (s: string) => string;

const truecolor = (r: number, g: number, b: number): Style => (s) =>
  colorEnabled ? `${ESC}[38;2;${r};${g};${b}m${s}${ESC}[39m` : s;

const attr = (on: number, off: number): Style => (s) => (colorEnabled ? `${ESC}[${on}m${s}${ESC}[${off}m` : s);

// Promptster palette (hex from the brand's dark-mode tokens — the variants that
// read well on a dark terminal) plus the rubric status colors.
export const c = {
  orange: truecolor(0xf2, 0x8c, 0x28), // --primary: headings, structure
  gold: truecolor(0xff, 0xcb, 0x6b), // --accent-gold: money, the number that matters
  border: truecolor(0xa8, 0x5d, 0x2a), // muted orange so content out-pops the frame
  emerald: truecolor(0x10, 0xb9, 0x81), // good / recoverable wins
  amber: truecolor(0xf5, 0x9e, 0x0b), // caution
  red: truecolor(0xef, 0x44, 0x44), // warning / waste
  cyan: truecolor(0x22, 0xd3, 0xee), // actionable fixes / levers
  bold: attr(1, 22),
  dim: attr(2, 22),
};

// eslint-disable-next-line no-control-regex -- stripping SGR escape sequences is the point
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
export const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');
/** Visible width, ignoring escape codes. Good enough: the report uses only
 *  width-1 glyphs (box-drawing, arrows, middot, the warning sign). */
export const visLen = (s: string): number => stripAnsi(s).length;

/** Pad a (possibly colored) string to `width` visible columns. Won't truncate —
 *  callers keep content within width; an overflow just skips padding. */
const padTo = (s: string, width: number): string => {
  const gap = width - visLen(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
};

export const BOX_WIDTH = 76; // inner content columns

/**
 * Render a titled, full-bordered card. `title` sits in the top rule; each entry
 * of `rows` becomes one bordered line (already-colored content is fine — width
 * is measured on visible glyphs). `accent` colors the frame; the title is bold.
 */
export function card(title: string, rows: string[], accent: Style = c.border, width = BOX_WIDTH): string[] {
  const head = `─ ${c.bold(accent(title))} `;
  const fill = '─'.repeat(Math.max(0, width + 2 - visLen(head)));
  const out = [accent('╭') + accent(head) + accent(fill) + accent('╮')];
  for (const row of rows) {
    out.push(`${accent('│')} ${padTo(row, width)} ${accent('│')}`);
  }
  out.push(accent('╰') + accent('─'.repeat(width + 2)) + accent('╯'));
  return out;
}

/**
 * A section with a colored header bar and a left gutter rail, but no right wall —
 * for wide detail tables whose rows can run past the box width without breaking
 * alignment. `▌` marks the header; each row gets a `│` rail.
 */
export function panel(title: string, rows: string[], accent: Style = c.border): string[] {
  const out = [`${accent('▌')} ${c.bold(accent(title))}`];
  for (const row of rows) out.push(`${accent('│')} ${row}`);
  out.push(accent('╵'));
  return out;
}

/** A thin divider used inside cards to separate stacked groups. */
export const rule = (width = 70): string => c.dim(c.border('┄'.repeat(width)));

/** Greedy word-wrap for plain (uncolored) free text — keeps long file paths and
 *  action sentences inside a card. Returns one string per visual line. */
export function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > width) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}
