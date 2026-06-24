# @promptster/cc-audit

Point it at your Claude Code transcripts and see where the money — and the bad habits — are.

```bash
npx @promptster/cc-audit
```

That's it. No install, no API key, no signup. It reads your local Claude Code history
(`~/.claude/projects`) and shows you spend by model, model right-sizing (where you're paying
for Opus on work Sonnet would nail), and AI-fluency signals like plan-mode rate and
always-on context tax.

## What leaves your machine

**By default: nothing.** The audit runs fully local.

Two optional steps upload data, and each asks first:

- **Right-sizing analysis** sends each task's *gist + metadata* (model, token counts, turn
  shape) to our hosted model. Never your code, prompts, file paths, or repo names.
- **Shareable report** uploads the privacy-safe *aggregate* (shares and counts — never raw
  dollar amounts or code) to a public link you can send to your team.

A random anonymous machine ID (a hash, not your hostname) is generated for deduplication if
you share a report.

## Usage

```bash
npx @promptster/cc-audit                 # local audit (default)
npx @promptster/cc-audit --judge         # + hosted right-sizing analysis
npx @promptster/cc-audit --open          # + shareable public web report
npx @promptster/cc-audit --json          # machine-readable, local-only unless a flag is given

# repeat user? install it
npm i -g @promptster/cc-audit && cc-audit
```

Common flags: `--since-days N`, `--root DIR`, `--rows N`, `--aggressiveness conservative|balanced|aggressive`.

## Not the assessment CLI

This is **not** [`@promptster/cli`](https://www.npmjs.com/package/@promptster/cli) (bin:
`promptster`), which candidates use to run Promptster hiring assessments. `cc-audit` is a
standalone tool for auditing your *own* Claude Code spend and fluency. Different command,
different job — you can have both installed without conflict.

## License

MIT
