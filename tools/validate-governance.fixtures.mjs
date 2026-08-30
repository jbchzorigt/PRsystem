#!/usr/bin/env node
// Negative fixtures for the two Phase 03 governance drift checks.
//
//   node tools/validate-governance.fixtures.mjs
//
// A check nobody has watched fail is a check nobody knows works. Both of these
// exist because a document went stale silently — a GATE-SEC catalogue listing
// eight of eighteen sub-gates, and a ledger restating counts that had drifted
// from the section below it. Each fixture mutates one property of a *copy* and
// requires the validator to fail for that specific reason. The real documents
// are never modified.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNBOOK = join(ROOT, 'docs', 'implementation', 'database-bootstrap-runbook.md');
const PHASE_STATUS = join(ROOT, 'docs', 'implementation', 'phase-status.md');
const EVIDENCE_MANIFEST = join(ROOT, 'docs', 'implementation', 'phase-03-evidence.json');
const originalRunbook = readFileSync(RUNBOOK, 'utf8');
const originalPhaseStatus = readFileSync(PHASE_STATUS, 'utf8');
const originalManifest = readFileSync(EVIDENCE_MANIFEST, 'utf8');

const SOURCES = {
  runbook: { text: originalRunbook, env: 'PRSYSTEM_RUNBOOK', file: 'doc.md' },
  'phase-status': { text: originalPhaseStatus, env: 'PRSYSTEM_PHASE_STATUS', file: 'doc.md' },
  manifest: {
    text: originalManifest,
    env: 'PRSYSTEM_EVIDENCE_MANIFEST',
    file: 'phase-03-evidence.json',
  },
};

/**
 * Applies `change` only inside the canonical evidence region.
 *
 * Historical repair records carry their own result tables, and a document-wide
 * `replace` lands in the first of them — which is not the table under test.
 */
function inEvidenceRegion(text, change) {
  const begin = text.indexOf('<!-- phase-03-evidence:begin -->');
  const endMarker = '<!-- phase-03-evidence:end -->';
  const end = text.indexOf(endMarker);
  if (begin < 0 || end < 0) throw new Error('the evidence markers are missing');
  const region = text.slice(begin, end + endMarker.length);
  const changed = change(region);
  if (changed === region) throw new Error('the change did not alter the evidence region');
  return text.slice(0, begin) + changed + text.slice(end + endMarker.length);
}

/** Removes one command from the battery block, the evidence table and the manifest. */
function removeCommand(sources, command) {
  const manifest = JSON.parse(sources.manifest);
  manifest.battery = manifest.battery.filter((entry) => entry.command !== command);
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    'phase-status': sources['phase-status']
      .replace(new RegExp(`^${escaped}[^\n]*\n`, 'm'), '')
      .replace(new RegExp(`^\\| \`${escaped}\` \\|[^\n]*\n`, 'm'), ''),
    manifest: `${JSON.stringify(manifest, null, 2)}\n`,
  };
}

const FIXTURES = [
  {
    name: 'catalogue: a sub-gate removed',
    file: 'runbook',
    expect: /the catalogue omits SEC-SCHEDULER/,
    mutate: (text) => text.replace('`SEC-SCHEDULER`, ', ''),
  },
  {
    name: 'catalogue: the stated count no longer matches',
    file: 'runbook',
    expect: /says "seventeen" sub-gates, configuration has 18/,
    mutate: (text) =>
      text.replace('aggregates **eighteen** sub-gates', 'aggregates **seventeen** sub-gates'),
  },
  {
    name: 'catalogue: the section heading removed',
    file: 'runbook',
    expect: /no "### GATE-SEC sub-gate catalogue" section/,
    mutate: (text) => text.replace('### GATE-SEC sub-gate catalogue', '### Required check detail'),
  },
  {
    // A complete, correct-looking catalogue placed earlier in the file, while
    // the real one loses an entry. Taking the first match in the document
    // accepted this.
    name: 'catalogue: a complete decoy before the real one',
    file: 'runbook',
    expect: /the catalogue omits SEC-SCHEDULER/,
    mutate: (text) => {
      const decoy = [
        '## Appendix (decoy)',
        '',
        '`GATE-SEC` aggregates **eighteen** sub-gates:',
        '',
        '`SEC-ROLE`, `SEC-RLS`, `SEC-ACL-MATRIX`, `SEC-OWNERSHIP`, `SEC-LOCK-EVIDENCE`,',
        '`SEC-POOL-ERRORS`, `SEC-BOOTSTRAP`, `SEC-SCHEDULER`, `SEC-MAINTENANCE`,',
        '`SEC-STARTUP`, `SEC-STARTUP-WORKER`, `SEC-REGRESSION`, `SEC-AUDIT`,',
        '`SEC-PARTITION`, `SEC-POLICE-ISOLATION`, `SEC-KMS`, `SEC-PII-LEAK`,',
        '`SEC-SECRETS`.',
        '',
      ].join('\n');
      return `${decoy}${text.replace('`SEC-SCHEDULER`, ', '')}`;
    },
  },
  {
    // The canonical evidence label naming a different repair from the one the
    // current position and the newest section name. The check derives both
    // ordinals from the document, so this fixture mutates the label alone and
    // does not depend on which repair happens to be current.
    name: 'evidence: the measured-on label names an older repair',
    file: 'phase-status',
    expect: /measured on the [a-z]+-repair tree \(\d+\); the manifest declares/,
    mutate: (text) => {
      const current = /Measured on the ([a-z]+)-repair tree/.exec(text)?.[1];
      if (current === undefined) throw new Error('no "Measured on the …-repair tree" label');
      const older = current === 'ninth' ? 'eighth' : 'ninth';
      return text.replace(
        `Measured on the ${current}-repair tree`,
        `Measured on the ${older}-repair tree`,
      );
    },
  },
  {
    // A correct-looking marker pair placed *before* the canonical section, while
    // the real block inside it carries a stale label. `indexOf` took the first
    // begin and the first end, so the decoy supplied the region and the real
    // block went unread.
    name: 'evidence: a decoy marker pair before the canonical section',
    file: 'phase-status',
    expect: /expected exactly one begin marker and one end marker, found 2 and 2/,
    mutate: (text) => {
      const label = /Measured on the ([a-z]+)-repair tree/.exec(text)?.[1];
      if (label === undefined) throw new Error('no measured-on label');
      const decoy =
        `<!-- phase-03-evidence:begin -->\n\nMeasured on the ${label}-repair tree. ` +
        'Every command exited 0.\n\n<!-- phase-03-evidence:end -->\n\n';
      return text
        .replace('## Current position', `${decoy}## Current position`)
        .replace(
          `Measured on the ${label}-repair tree. Every command exited 0.\n\n| Command |`,
          'Measured on the first-repair tree. Every command exited 0.\n\n| Command |',
        );
    },
  },
  {
    name: 'evidence: a decoy marker pair after the canonical section',
    file: 'phase-status',
    expect: /expected exactly one begin marker and one end marker, found 2 and 2/,
    mutate: (text) =>
      `${text}\n<!-- phase-03-evidence:begin -->\n\nMeasured on the first-repair tree.\n\n` +
      '<!-- phase-03-evidence:end -->\n',
  },
  {
    name: 'evidence: a duplicate begin marker',
    file: 'phase-status',
    expect: /expected exactly one begin marker and one end marker, found 2 and 1/,
    mutate: (text) =>
      text.replace(
        '<!-- phase-03-evidence:begin -->',
        '<!-- phase-03-evidence:begin -->\n<!-- phase-03-evidence:begin -->',
      ),
  },
  {
    name: 'evidence: the markers reversed',
    file: 'phase-status',
    expect: /the end marker precedes the begin marker/,
    mutate: (text) =>
      text
        .replace('<!-- phase-03-evidence:begin -->', '<!-- phase-03-evidence:PLACEHOLDER -->')
        .replace('<!-- phase-03-evidence:end -->', '<!-- phase-03-evidence:begin -->')
        .replace('<!-- phase-03-evidence:PLACEHOLDER -->', '<!-- phase-03-evidence:end -->'),
  },
  {
    // The newest heading renumbered. The numeral was captured and never
    // compared, so `(customer review 12)` could become `(customer review 11)`.
    name: 'current position: the newest heading carries the wrong review number',
    file: 'phase-status',
    expect: /the last section is review \d+|disagrees with its own number/,
    mutate: (text) => {
      const headings = [
        ...text.matchAll(/### ([A-Za-z]+) security repair \(customer review (\d+)\)/g),
      ];
      const newest = headings[headings.length - 1];
      if (newest === undefined) throw new Error('no numbered repair section');
      return text.replace(
        newest[0],
        `### ${newest[1]} security repair (customer review ${String(Number(newest[2]) - 1)})`,
      );
    },
  },
  {
    // The marker pair wraps one correct-looking label while the real result
    // table sits outside it carrying a stale one. Marker geometry alone was
    // satisfied; the region's contents were never checked.
    name: 'evidence: the markers wrap a decoy label and nothing else',
    file: 'phase-status',
    expect: /results hold 0 tables; there must be exactly one/,
    mutate: (text) => {
      const begin = '<!-- phase-03-evidence:begin -->';
      const end = '<!-- phase-03-evidence:end -->';
      const from = text.indexOf(begin);
      const to = text.indexOf(end) + end.length;
      if (from < 0 || to < end.length) throw new Error('the evidence markers are missing');
      const inner = text.slice(from + begin.length, to - end.length);
      const label = /^Measured on the [a-z]+-repair tree[^\n]*/m.exec(inner)?.[0];
      if (label === undefined) throw new Error('no measured-on label');
      const stale = inner.replace(
        label,
        'Measured on the first-repair tree. Every command exited 0.',
      );
      return `${text.slice(0, from)}${begin}\n\n${label}\n\n${end}\n${stale}${text.slice(to)}`;
    },
  },
  {
    // A second row for the same key. The position is now four explicit rows
    // with unique keys, so a contradicting copy is a duplicate, not prose to be
    // shadowed by the first regex match.
    name: 'current position: a duplicate review-number row',
    file: 'phase-status',
    expect: /states "Customer review number" twice/,
    mutate: (text) => {
      const row = /^\|\s*Customer review number\s*\|[^\n]*$/m.exec(text)?.[0];
      if (row === undefined) throw new Error('no review-number row');
      return text.replace(row, `${row}\n| Customer review number | 9 |`);
    },
  },
  {
    name: 'current position: a duplicate phase-state row',
    file: 'phase-status',
    expect: /states "Phase state" twice/,
    mutate: (text) => {
      const row = /^\|\s*Phase state\s*\|[^\n]*$/m.exec(text)?.[0];
      if (row === undefined) throw new Error('no Phase state row');
      return text.replace(row, `${row}\n| Phase state | \`DONE\` |`);
    },
  },
  {
    name: 'current position: acceptance claimed',
    file: 'phase-status',
    expect: /states Customer acceptance = /,
    mutate: (text) =>
      text.replace(
        '| Customer acceptance | `NOT_ACCEPTED` |',
        '| Customer acceptance | `ACCEPTED` |',
      ),
  },
  {
    name: 'history: the latest heading duplicated',
    file: 'phase-status',
    expect: /the repair history repeats a review number/,
    mutate: (text) => {
      const headings = [
        ...text.matchAll(/^### [A-Za-z]+ security repair \(customer review \d+\)[^\n]*$/gm),
      ];
      const newest = headings[headings.length - 1]?.[0];
      if (newest === undefined) throw new Error('no repair heading');
      return text.replace(newest, `${newest}\n\n(duplicate)\n\n${newest}`);
    },
  },
  {
    name: 'history: a malformed near-match heading',
    file: 'phase-status',
    expect: /describes a repair or a customer review but is not a canonical, unindented H3/,
    mutate: (text) => {
      const heading = /^### Ninth security repair \(customer review 9\)[^\n]*$/m.exec(text)?.[0];
      if (heading === undefined) throw new Error('no ninth repair heading');
      return text.replace(heading, '### Ninth security repair — legacy format');
    },
  },
  {
    name: 'history: a record replaced by an undeclared heading',
    file: 'phase-status',
    expect:
      /neither a canonical repair heading nor a declared section heading: ### Ninth pass notes/,
    mutate: (text) => {
      const heading = /^### Ninth security repair \(customer review 9\)[^\n]*$/m.exec(text)?.[0];
      if (heading === undefined) throw new Error('no ninth repair heading');
      return text.replace(heading, '### Ninth pass notes');
    },
  },
  {
    name: 'history: two sections transposed',
    file: 'phase-status',
    expect: /the repair history is \[[\d,]+\]; it must be 1\.\.\d+ exactly/,
    mutate: (text) => {
      const ninth = /^### Ninth security repair \(customer review 9\)[^\n]*$/m.exec(text)?.[0];
      const tenth = /^### Tenth security repair \(customer review 10\)[^\n]*$/m.exec(text)?.[0];
      if (ninth === undefined || tenth === undefined) throw new Error('missing repair headings');
      return text
        .replace(ninth, '@@NINTH@@')
        .replace(tenth, '@@TENTH@@')
        .replace('@@NINTH@@', tenth)
        .replace('@@TENTH@@', ninth);
    },
  },
  {
    // A result changed to prose that reads like an outcome. The status was not a
    // field, so "FAILED — not run" was a result like any other.
    name: 'evidence: a result recorded as failed',
    file: 'phase-status',
    expect: /records a status other than PASS/,
    mutate: (text) =>
      inEvidenceRegion(text, (region) =>
        region.replace(
          '| `pnpm run test:e2e` | PASS |',
          '| `pnpm run test:e2e` | FAILED — not run |',
        ),
      ),
  },
  {
    name: 'evidence: two conflicting rows for one command',
    file: 'phase-status',
    expect: /carry two rows for pnpm run test:e2e/,
    mutate: (text) =>
      inEvidenceRegion(text, (region) => {
        const row = /^\| `pnpm run test:e2e` \|[^\n]*$/m.exec(region)?.[0];
        if (row === undefined) throw new Error('no test:e2e result row');
        return region.replace(row, `${row}\n| \`pnpm run test:e2e\` | PASS | 3 |`);
      }),
  },
  {
    name: 'evidence: a result row for a command the battery does not list',
    file: 'phase-status',
    expect: /report a command the manifest does not declare/,
    mutate: (text) =>
      inEvidenceRegion(text, (region) => {
        const row = /^\| `pnpm run test:e2e` \|[^\n]*$/m.exec(region)?.[0];
        if (row === undefined) throw new Error('no test:e2e result row');
        return region.replace(row, `${row}\n| \`pnpm run invented\` | PASS | 1 |`);
      }),
  },
  {
    // Two labels on one line counted as one matching line, and the second could
    // name any tree at all.
    name: 'evidence: two measured-on labels on one line',
    file: 'phase-status',
    expect: /carry 2 visible measured-on labels/,
    mutate: (text) => {
      const label = /^Measured on the [a-z]+-repair tree[^\n]*$/m.exec(text)?.[0];
      if (label === undefined) throw new Error('no measured-on label');
      return text.replace(
        label,
        `${label} Measured on the first-repair tree. Every command exited 0.`,
      );
    },
  },
  {
    name: 'current position: the review and repair numbers disagree',
    file: 'phase-status',
    expect: /states Latest implemented repair number = /,
    mutate: (text) => {
      const row = /^\|\s*Latest implemented repair number\s*\|\s*(\d+)\s*\|$/m.exec(text);
      if (row === null) throw new Error('no repair-number row');
      return text.replace(
        row[0],
        `| Latest implemented repair number | ${String(Number(row[1]) - 1)} |`,
      );
    },
  },
  {
    name: 'current position: the state disagrees with the ledger',
    file: 'phase-status',
    expect: /states Phase state = /,
    mutate: (text) =>
      text.replace('| Phase state | `SECURITY_REPAIR_REQUIRED` |', '| Phase state | `DONE` |'),
  },
  {
    // The ledger used to keep its own copy of the repair ordinal, and it went
    // stale. The copy is gone; restoring one is refused.
    name: 'ledger: the repair ordinal restated',
    file: 'phase-status',
    expect: /ledger row restates the repair ordinal/,
    mutate: (text) =>
      text.replace(/^(\| 03 \| Platform kernel \|[^\n]*)$/m, (row) =>
        row.replace('every repair is listed', 'the ninth repair is listed'),
      ),
  },
  {
    // Neither "security repair" nor "(customer review" appears, so a rule keyed
    // on those words could not see it. An empty canonical decoy kept the
    // sequence intact.
    name: 'history: a malformed record heading behind an empty canonical decoy',
    file: 'phase-status',
    expect: /unindented H3 repair heading: ### Ninth repair notes/,
    mutate: (text) => {
      const real = /^### Ninth security repair \(customer review 9\)[^\n]*$/m.exec(text)?.[0];
      if (real === undefined) throw new Error('no ninth repair heading');
      return text.replace(real, `${real}\n\n(empty decoy)\n\n### Ninth repair notes\n`);
    },
  },
  {
    name: 'history: an extra noncanonical record appended after the newest',
    file: 'phase-status',
    expect: /unindented H3 repair heading: ### Fifteenth repair notes/,
    mutate: (text) =>
      text.replace(
        '## Update protocol',
        '### Fifteenth repair notes\n\n(placeholder)\n\n## Update protocol',
      ),
  },
  {
    name: 'history: a canonical record outside the bounded region',
    file: 'phase-status',
    expect: /sits outside the bounded repair history/,
    mutate: (text) =>
      text.replace(
        '<!-- phase-03-repair-history:begin -->',
        '### Fifteenth security repair (customer review 15) — `SECURITY_REPAIR_REQUIRED`\n\n' +
          '<!-- phase-03-repair-history:begin -->',
      ),
  },
  {
    // The header row is the table's contract. Swapping two columns kept every
    // cell in place while every value moved to a field that means something
    // else.
    name: 'evidence: the Status and Result headers swapped',
    file: 'phase-status',
    expect: /table header is "Command \| Result \| Status"/,
    mutate: (text) =>
      inEvidenceRegion(text, (region) =>
        region.replace('| Command | Status | Result |', '| Command | Result | Status |'),
      ),
  },
  {
    // A row that names the command without backticks read as prose to a pattern
    // anchored on "| `command` |", so it sat beside the real row saying the
    // opposite.
    name: 'evidence: a duplicate row without backticks',
    file: 'phase-status',
    expect: /a result row names 0 backticked commands/,
    mutate: (text) =>
      inEvidenceRegion(text, (region) => {
        const row = /^\| `pnpm run test:e2e` \|[^\n]*$/m.exec(region)?.[0];
        if (row === undefined) throw new Error('no test:e2e result row');
        return region.replace(row, `${row}\n| pnpm run test:e2e | FAILED — not run | 0 |`);
      }),
  },
  {
    // Markdown renders a row indented by up to three spaces as part of the same
    // table. A pattern anchored at the start of the line did not see it.
    name: 'evidence: a one-space-indented duplicate row',
    file: 'phase-status',
    expect: /carry two rows for pnpm run test:e2e/,
    mutate: (text) =>
      inEvidenceRegion(text, (region) => {
        const row = /^\| `pnpm run test:e2e` \|[^\n]*$/m.exec(region)?.[0];
        if (row === undefined) throw new Error('no test:e2e result row');
        return region.replace(row, `${row}\n | \`pnpm run test:e2e\` | FAILED — not run | 0 |`);
      }),
  },
  {
    name: 'evidence: PASS beside a result that says the command was not run',
    file: 'phase-status',
    expect: /result for pnpm run test:e2e is "FAILED — command was not run"/,
    mutate: (text) =>
      inEvidenceRegion(text, (region) =>
        region.replace(
          /^\| `pnpm run test:e2e` \|[^\n]*$/m,
          '| `pnpm run test:e2e` | PASS | FAILED — command was not run |',
        ),
      ),
  },
  {
    name: 'evidence: a blank result',
    file: 'phase-status',
    expect: /result for pnpm run test:e2e is ""/,
    mutate: (text) =>
      inEvidenceRegion(text, (region) =>
        region.replace(/^\| `pnpm run test:e2e` \|[^\n]*$/m, '| `pnpm run test:e2e` | PASS |  |'),
      ),
  },
  {
    name: 'evidence: a row with the wrong number of cells',
    file: 'phase-status',
    expect: /a canonical evidence row has 4 cells/,
    mutate: (text) =>
      inEvidenceRegion(text, (region) =>
        region.replace(
          /^\| `pnpm run test:e2e` \|[^\n]*$/m,
          '| `pnpm run test:e2e` | PASS | 15 | extra |',
        ),
      ),
  },
  {
    name: 'evidence: a second table inside the region',
    file: 'phase-status',
    expect: /hold 2 tables; there must be exactly one/,
    mutate: (text) =>
      inEvidenceRegion(text, (region) =>
        region.replace(
          '### GATE-SEC sub-gate counts',
          '| Command | Status | Result |\n| --- | --- | --- |\n\n### GATE-SEC sub-gate counts',
        ),
      ),
  },
  {
    // The exact reproduction: the real record hidden below a malformed H4 while
    // an empty canonical H3 keeps the sequence intact.
    name: 'history: an empty H3 decoy above a malformed H4 record',
    file: 'phase-status',
    expect: /unindented H3 repair heading: #### Ninth security repair/,
    mutate: (text) => {
      const real = /^### Ninth security repair \(customer review 9\)[^\n]*$/m.exec(text)?.[0];
      if (real === undefined) throw new Error('no ninth repair heading');
      return text.replace(
        real,
        `${real}\n\n(empty decoy)\n\n#### Ninth security repair (customer review 9)\n`,
      );
    },
  },
  {
    name: 'history: an H2 repair heading',
    file: 'phase-status',
    expect: /unindented H3 repair heading: ## Sixteenth security repair/,
    mutate: (text) =>
      text.replace(
        '## Update protocol',
        '## Sixteenth security repair (customer review 16)\n\n(h2 record)\n\n## Update protocol',
      ),
  },
  {
    name: 'history: an indented H3 repair heading',
    file: 'phase-status',
    expect: /unindented H3 repair heading:\s+### Sixteenth security repair/,
    mutate: (text) =>
      text.replace(
        '## Update protocol',
        '   ### Sixteenth security repair (customer review 16) — `SECURITY_REPAIR_REQUIRED`\n\n' +
          '(indented h3)\n\n## Update protocol',
      ),
  },
  {
    // GFM does not require the outer pipes. A pattern anchored on "|" did not
    // see this line as a row at all, and it sat in the table saying something
    // else.
    name: 'evidence: a GFM row without leading or trailing pipes',
    file: 'phase-status',
    expect: /carry two rows for pnpm run test:e2e/,
    mutate: (text) =>
      inEvidenceRegion(text, (region) => {
        const row = /^\| `pnpm run test:e2e` \|[^\n]*$/m.exec(region)?.[0];
        if (row === undefined) throw new Error('no test:e2e result row');
        return region.replace(row, `${row}\n\`pnpm run test:e2e\` | PASS | 0 findings`);
      }),
  },
  {
    // Success is the recorded exit code, never the prose beside it.
    name: 'evidence: PASS beside a result that reports exit 1',
    file: 'phase-status',
    expect: /result for pnpm run test:e2e is "15 tests, exit 1"/,
    mutate: (text) =>
      inEvidenceRegion(text, (region) =>
        region.replace(
          /^\| `pnpm run test:e2e` \|[^\n]*$/m,
          '| `pnpm run test:e2e` | PASS | 15 tests, exit 1 |',
        ),
      ),
  },
  {
    name: 'manifest: a non-zero exit code recorded for a battery command',
    file: 'manifest',
    expect: /records a non-zero exit code/,
    mutate: (json) => json.replace('"exits": [0]', '"exits": [1]'),
  },
  {
    name: 'manifest: an execution count that does not match the exit codes',
    file: 'manifest',
    expect: /declares 3 executions and 2 exit codes/,
    mutate: (json) => json.replace('"exits": [0, 0, 0]', '"exits": [0, 0]'),
  },
  {
    name: 'current position: a duplicate Current position H2',
    file: 'phase-status',
    expect: /there are 2 visible "Current position" H2 headings/,
    mutate: (text) =>
      text.replace(
        '## Current position',
        '## Current position\n\n| Field | Value |\n| --- | --- |\n| Phase state | `DONE` |\n\n' +
          '## Current position',
      ),
  },
  {
    // GFM truncates a row with too many cells, so the parsed row is the right
    // width and only the written shape shows the mistake.
    name: 'current position: a malformed three-cell row',
    file: 'phase-status',
    expect: /a current-position row has 3 cells; the table declares 2/,
    mutate: (text) =>
      text.replace(
        '| Phase state | `SECURITY_REPAIR_REQUIRED` |',
        '| Phase state | `SECURITY_REPAIR_REQUIRED` | extra |',
      ),
  },
  {
    name: 'ledger: a second state token in the Phase 03 row',
    file: 'phase-status',
    expect: /ledger row names 2 state tokens/,
    mutate: (text) =>
      text.replace(/^(\| 03 \| Platform kernel \|[^\n]*)$/m, (row) =>
        row.replace('`0001_kernel`', '`0001_kernel` `DONE`'),
      ),
  },
  {
    // An HTML comment renders as nothing. A correct label written inside one and
    // a stale label beside it is what a reader would actually see.
    name: 'evidence: the correct label hidden in a comment beside a stale one',
    file: 'phase-status',
    expect: /raw HTML in a governed region is not an approved boundary marker/,
    mutate: (text) => {
      const label = /^Measured on the [a-z]+-repair tree[^\n]*$/m.exec(text)?.[0];
      if (label === undefined) throw new Error('no measured-on label');
      return text.replace(
        label,
        `<!-- ${label} -->\nMeasured on the first-repair tree. Every command exited 0.`,
      );
    },
  },
  {
    name: 'history: a Setext repair heading',
    file: 'phase-status',
    expect: /unindented H3 repair heading: Seventeenth security repair/,
    mutate: (text) =>
      text.replace(
        '## Update protocol',
        'Seventeenth security repair (customer review 17)\n' +
          '---------------------------------------------\n\n(setext)\n\n## Update protocol',
      ),
  },
  {
    name: 'history: a raw <h3> repair heading',
    file: 'phase-status',
    expect: /raw HTML in a governed region is not an approved boundary marker: <h3>/,
    mutate: (text) =>
      text.replace(
        '## Update protocol',
        '<h3>Seventeenth security repair (customer review 17)</h3>\n\n(raw)\n\n## Update protocol',
      ),
  },
  {
    name: 'history: a tab-separated ATX repair heading',
    file: 'phase-status',
    expect: /unindented H3 repair heading:\s+###\s+Seventeenth security repair/,
    mutate: (text) =>
      text.replace(
        '## Update protocol',
        '###\tSeventeenth security repair (customer review 17)\n\n(tab)\n\n## Update protocol',
      ),
  },
  {
    name: 'history: a canonical heading hidden in a comment beside a visible record',
    file: 'phase-status',
    expect: /raw HTML in a governed region is not an approved boundary marker: <!-- ###/,
    mutate: (text) => {
      const real = /^### Ninth security repair \(customer review 9\)[^\n]*$/m.exec(text)?.[0];
      if (real === undefined) throw new Error('no ninth repair heading');
      return text.replace(real, `<!-- ${real} -->\n\n### Ninth repair record\n`);
    },
  },
  {
    // The three places a command is written could be edited together, so the
    // gate deleted itself and governance still reported 15 of 15. What must be
    // measured is declared in `phase-03-battery.mjs`, which the document cannot
    // reach.
    name: 'coordinated: test:security removed from manifest, battery and table',
    files: ['phase-status', 'manifest'],
    expect: /omits required battery commands: pnpm run test:security/,
    mutate: (sources) => removeCommand(sources, 'pnpm run test:security'),
  },
  {
    name: 'coordinated: the battery reduced to one command everywhere',
    files: ['phase-status', 'manifest'],
    expect: /omits required battery commands/,
    mutate: (sources) => {
      let next = sources;
      for (const entry of JSON.parse(sources.manifest).battery) {
        if (entry.command === 'git diff --check') continue;
        next = removeCommand(next, entry.command);
      }
      return next;
    },
  },
  {
    name: 'coordinated: a command duplicated in the manifest and the battery',
    files: ['phase-status', 'manifest'],
    expect: /lists a command twice/,
    mutate: (sources) => {
      const manifest = JSON.parse(sources.manifest);
      const entry = manifest.battery.find((candidate) => candidate.command === 'pnpm run test:e2e');
      manifest.battery.push({ ...entry });
      return {
        'phase-status': sources['phase-status'].replace(
          /^pnpm run test:e2e[^\n]*$/m,
          (line) => `${line}\n${line}`,
        ),
        manifest: `${JSON.stringify(manifest, null, 2)}\n`,
      };
    },
  },
  {
    // Acceptance is the customer's to give. The document may not vote itself
    // done.
    name: 'coordinated: DONE in the manifest, the position and the ledger',
    files: ['phase-status', 'manifest'],
    expect: /declares phaseState = "DONE"; the governed state is "SECURITY_REPAIR_REQUIRED"/,
    mutate: (sources) => {
      const manifest = JSON.parse(sources.manifest);
      manifest.phaseState = 'DONE';
      return {
        'phase-status': sources['phase-status']
          .replace('| Phase state | `SECURITY_REPAIR_REQUIRED` |', '| Phase state | `DONE` |')
          .replace(/^(\| 03 \| Platform kernel \| )`SECURITY_REPAIR_REQUIRED`/m, '$1`DONE`'),
        manifest: `${JSON.stringify(manifest, null, 2)}\n`,
      };
    },
  },
  {
    name: 'coordinated: the current phase advanced to Phase 04',
    files: ['phase-status', 'manifest'],
    expect: /declares currentPhase = "04 [^"]*"; the governed state is "03 — Platform kernel"/,
    mutate: (sources) => {
      const manifest = JSON.parse(sources.manifest);
      manifest.currentPhase = '04 — IAM, tenancy, RBAC, and staff lifecycle';
      return {
        'phase-status': sources['phase-status'].replace(
          '| Current phase | 03 — Platform kernel |',
          '| Current phase | 04 — IAM, tenancy, RBAC, and staff lifecycle |',
        ),
        manifest: `${JSON.stringify(manifest, null, 2)}\n`,
      };
    },
  },
  {
    name: 'coordinated: Phase 04 no longer NOT STARTED in the ledger',
    file: 'phase-status',
    expect: /the Phase 04 ledger row says [A-Z_ ]+; the governed state is NOT STARTED/,
    mutate: (text) => text.replace(/^(\| 04 \|[^|]*\| )`NOT STARTED`/m, '$1`IN PROGRESS`'),
  },
  {
    name: 'coordinated: one repair removed from the manifest and the history',
    files: ['phase-status', 'manifest'],
    expect: /the repair history is \[[\d,]+\]; it must be 1\.\.\d+ exactly/,
    mutate: (sources) => {
      const manifest = JSON.parse(sources.manifest);
      manifest.repairHistory = manifest.repairHistory.filter((n) => n !== 9);
      return {
        'phase-status': sources['phase-status'].replace(
          /^### Ninth security repair \(customer review 9\)[^\n]*\n/m,
          '',
        ),
        manifest: `${JSON.stringify(manifest, null, 2)}\n`,
      };
    },
  },
  {
    name: 'coordinated: a repair number duplicated in the manifest and the history',
    files: ['phase-status', 'manifest'],
    expect: /the repair history repeats a review number/,
    mutate: (sources) => {
      const manifest = JSON.parse(sources.manifest);
      manifest.repairHistory = [...manifest.repairHistory, manifest.latestRepairNumber];
      const heading = new RegExp(
        '^### [A-Za-z]+ security repair \\(customer review ' +
          String(manifest.latestRepairNumber) +
          '\\)[^\\n]*$',
        'm',
      ).exec(sources['phase-status'])?.[0];
      if (heading === undefined) throw new Error('no newest repair heading');
      return {
        'phase-status': sources['phase-status'].replace(
          heading,
          `${heading}\n\n(dup)\n\n${heading}`,
        ),
        manifest: `${JSON.stringify(manifest, null, 2)}\n`,
      };
    },
  },
  {
    name: 'manifest: an unreviewed extra key',
    file: 'manifest',
    expect: /it must declare exactly/,
    mutate: (json) => json.replace('{\n  "currentPhase"', '{\n  "extra": 1,\n  "currentPhase"'),
  },
  {
    // The canonical form carries the governed state, so a heading claiming a
    // different one is not canonical — and a heading that mentions a repair and
    // is not canonical is refused.
    name: 'coordinated: a repair heading claiming another state',
    file: 'phase-status',
    expect:
      /unindented H3 repair heading: ### Ninth security repair \(customer review 9\) — `DONE`/,
    mutate: (text) =>
      text.replace(
        /^(### Ninth security repair \(customer review 9\) — )`SECURITY_REPAIR_REQUIRED`$/m,
        '$1`DONE`',
      ),
  },
  {
    name: 'evidence: the results markers removed',
    file: 'phase-status',
    expect:
      /phase-03-evidence: expected exactly one begin marker and one end marker, found 0 and 0/,
    mutate: (text) =>
      text
        .replace('<!-- phase-03-evidence:begin -->\n\n', '')
        .replace('\n<!-- phase-03-evidence:end -->\n', ''),
  },
  {
    // The whole marked block moved out of the canonical section. A `##` section
    // runs to the next `##`, so "inside the section" has to be asserted rather
    // than assumed from where the text happens to sit.
    name: 'evidence: the results moved outside the canonical section',
    file: 'phase-status',
    expect: /canonical evidence results is not inside the canonical evidence section/,
    mutate: (text) => {
      const begin = text.indexOf('<!-- phase-03-evidence:begin -->');
      const endMarker = '<!-- phase-03-evidence:end -->';
      const end = text.indexOf(endMarker);
      if (begin < 0 || end < 0) throw new Error('the evidence markers are missing');
      const block = text.slice(begin, end + endMarker.length);
      return `${text.slice(0, begin)}${text.slice(end + endMarker.length)}\n\n${block}\n`;
    },
  },
  {
    name: 'evidence: the measured-on label removed entirely',
    file: 'phase-status',
    expect: /carry 0 visible measured-on labels/,
    mutate: (text) =>
      text.replace(/Measured on the [a-z]+-repair tree\./, 'Measured on the final tree.'),
  },
  {
    name: 'ledger: an N/N ratio restated',
    file: 'phase-status',
    expect: /ledger row restates an N\/N ratio/,
    mutate: (text) =>
      text.replace(/^(\| 03 \| Platform kernel \|[^\n]*)$/m, (row) =>
        row.replace('the full battery', 'the full battery, 15/15 checks'),
      ),
  },
  {
    name: 'ledger: a test count restated',
    file: 'phase-status',
    expect: /ledger row restates a test count/,
    mutate: (text) =>
      text.replace(/^(\| 03 \| Platform kernel \|[^\n]*)$/m, (row) =>
        row.replace('the full battery', 'the full battery, 999 tests'),
      ),
  },
  {
    name: 'gate battery: a check count restated',
    file: 'phase-status',
    // `15/15 checks` is both a ratio and a check count; the ratio pattern is
    // listed first, so that is the diagnostic.
    expect: /gate battery restates an N\/N ratio/,
    mutate: (text) =>
      text.replace(
        'node tools/validate-governance.mjs                       # GATE-GOV',
        'node tools/validate-governance.mjs                       # GATE-GOV — 15/15 checks',
      ),
  },
  {
    name: 'gate battery: moved outside its markers',
    file: 'phase-status',
    expect: /gate battery is not inside the canonical evidence section/,
    mutate: (text) => {
      const open = '<!-- phase-03-gate-battery:begin -->';
      const close = '<!-- phase-03-gate-battery:end -->';
      const from = text.indexOf(open);
      const to = text.indexOf(close) + close.length;
      const block = text.slice(from, to);
      // Removed from the canonical section and dropped into the Phase 00 record,
      // which is exactly where it used to be.
      return text
        .slice(0, from)
        .replace('## Phase 00 record', `## Phase 00 record\n\n${block}\n`)
        .concat(text.slice(to));
    },
  },
  {
    name: 'gate battery: markers removed',
    file: 'phase-status',
    expect:
      /phase-03-gate-battery: expected exactly one begin marker and one end marker, found 0 and 1/,
    mutate: (text) => text.replace('<!-- phase-03-gate-battery:begin -->', ''),
  },
  {
    name: 'ledger: the canonical link removed',
    file: 'phase-status',
    expect: /ledger row does not link/,
    mutate: (text) =>
      text.replace(/^(\| 03 \| Platform kernel \|[^\n]*)$/m, (row) =>
        row.replace(
          /\[Current Phase 03 evidence\]\(#current-phase-03-evidence\)/,
          'the evidence section',
        ),
      ),
  },
  {
    name: 'canonical section: duplicated',
    file: 'phase-status',
    expect: /gate battery is not inside the canonical evidence section/,
    mutate: (text) =>
      text.replace(
        '## Current Phase 03 evidence',
        '## Current Phase 03 evidence\n\n(placeholder)\n\n## Current Phase 03 evidence',
      ),
  },
  {
    name: 'canonical section: removed',
    file: 'phase-status',
    expect: /no visible "Current Phase 03 evidence" H2/,
    mutate: (text) => text.replace(/^## Current Phase 03 evidence$/m, '## Evidence'),
  },
  {
    // Derived from the document, not written against whichever repair happens to
    // be current. Two of these fixtures used to name `eleven`/`eleventh`
    // literally and silently stopped mutating anything the moment the count
    // advanced — a negative fixture that changes nothing proves nothing.
    name: 'current position: a stale review number',
    file: 'phase-status',
    expect: /states Customer review number = /,
    mutate: (text) => {
      const row = /^\|\s*Customer review number\s*\|\s*(\d+)\s*\|$/m.exec(text);
      if (row === null) throw new Error('no review-number row');
      return text.replace(row[0], `| Customer review number | ${String(Number(row[1]) - 1)} |`);
    },
  },
  {
    name: 'current position: the history runs past the stated repair number',
    file: 'phase-status',
    expect: /measured on the [a-z]+-repair tree \(\d+\); the manifest declares/,
    mutate: (text) => {
      const review = /^\|\s*Customer review number\s*\|\s*(\d+)\s*\|$/m.exec(text);
      const repair = /^\|\s*Latest implemented repair number\s*\|\s*(\d+)\s*\|$/m.exec(text);
      const label = /^Measured on the ([a-z]+)-repair tree/m.exec(text);
      if (review === null || repair === null || label === null) {
        throw new Error('the current position or the measured-on label is missing');
      }
      // The label moves with the numbers, so the *history length* is the one
      // thing left disagreeing.
      const ORDINALS = [
        'first',
        'second',
        'third',
        'fourth',
        'fifth',
        'sixth',
        'seventh',
        'eighth',
        'ninth',
        'tenth',
        'eleventh',
        'twelfth',
        'thirteenth',
        'fourteenth',
        'fifteenth',
        'sixteenth',
        'seventeenth',
      ];
      const lower = Number(review[1]) - 1;
      return text
        .replace(review[0], `| Customer review number | ${String(lower)} |`)
        .replace(repair[0], `| Latest implemented repair number | ${String(lower)} |`)
        .replace(label[0], `Measured on the ${ORDINALS[lower - 1]}-repair tree`);
    },
  },
  {
    name: 'a historical section reclaims the current counts',
    file: 'phase-status',
    expect: /superseded section still claims to be current/,
    mutate: (text) =>
      text.replace(
        '> **Historical snapshot.** Superseded. Current results are in',
        '> **This section holds the current counts.** Superseded. Current results are in',
      ),
  },
];

const results = [];
let failures = 0;

/** True when the validator printed a FAIL line matching `expected`. */
function failedFor(output, expected) {
  return output
    .split('\n')
    .filter((line) => line.startsWith('[FAIL]'))
    .some((line) => expected.test(line));
}

for (const fixture of FIXTURES) {
  // A fixture names one source, or several when the mutation is coordinated —
  // the manifest, the battery block and the evidence table changed together is
  // exactly the shape this check has to refuse.
  const names = fixture.files ?? [fixture.file];
  const originals = Object.fromEntries(names.map((name) => [name, SOURCES[name].text]));
  const mutatedAll =
    fixture.files === undefined
      ? { [fixture.file]: fixture.mutate(originals[fixture.file]) }
      : fixture.mutate(originals);
  const changed = names.filter((name) => mutatedAll[name] !== originals[name]);
  if (changed.length === 0) {
    results.push({ name: fixture.name, ok: false, detail: 'fixture did not change the document' });
    failures += 1;
    continue;
  }

  const dir = mkdtempSync(join(tmpdir(), 'prsystem-gov-fixture-'));
  try {
    const env = { ...process.env };
    for (const name of names) {
      const path = join(dir, SOURCES[name].file);
      writeFileSync(path, mutatedAll[name]);
      env[SOURCES[name].env] = path;
    }
    const run = spawnSync(process.execPath, [join(ROOT, 'tools', 'validate-governance.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      env,
    });
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    if (process.env['PRSYSTEM_FIXTURE_VERBOSE'] === '1') {
      const line = output.split('\n').find((l) => l.startsWith('[FAIL]'));
      console.error(`### ${fixture.name} :: ${String(line)}`);
    }
    const rejected = run.status !== 0;
    const diagnosed = failedFor(output, fixture.expect);
    results.push({
      name: fixture.name,
      ok: rejected && diagnosed,
      detail: !rejected
        ? 'ACCEPTED — the drift was not caught'
        : diagnosed
          ? `rejected (exit ${String(run.status)})`
          : `rejected, but not by ${String(fixture.expect)}`,
    });
    if (!rejected || !diagnosed) failures += 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Controls: the real documents are untouched, and unmutated they still pass.
for (const [name, path, original] of [
  ['runbook', RUNBOOK, originalRunbook],
  ['phase-status', PHASE_STATUS, originalPhaseStatus],
  ['the evidence manifest', EVIDENCE_MANIFEST, originalManifest],
]) {
  const unchanged = readFileSync(path, 'utf8') === original;
  results.push({
    name: `control: ${name} is unmodified`,
    ok: unchanged,
    detail: unchanged ? 'byte-identical' : 'THE DOCUMENT WAS MODIFIED',
  });
  if (!unchanged) failures += 1;
}

const control = spawnSync(process.execPath, [join(ROOT, 'tools', 'validate-governance.mjs')], {
  cwd: ROOT,
  encoding: 'utf8',
});
results.push({
  name: 'control: the real documents pass',
  ok: control.status === 0,
  detail: control.status === 0 ? 'accepted' : `rejected (exit ${String(control.status)})`,
});
if (control.status !== 0) failures += 1;

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.name.padEnd(width)}  ${r.detail}`);
}
console.log(
  `\ngovernance drift fixtures: ${String(results.length - failures)}/${String(results.length)} caught` +
    (failures ? `, ${String(failures)} NOT CAUGHT` : ''),
);
process.exit(failures ? 1 : 0);
