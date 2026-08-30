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
const originalRunbook = readFileSync(RUNBOOK, 'utf8');
const originalPhaseStatus = readFileSync(PHASE_STATUS, 'utf8');

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
    expect: /measured on the [a-z]+-repair tree" \(\d+\); the current position/,
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
    expect: /states customer acceptance "ACCEPTED"/,
    mutate: (text) =>
      text.replace(
        '| Customer acceptance | `NOT_ACCEPTED` |',
        '| Customer acceptance | `ACCEPTED` |',
      ),
  },
  {
    name: 'history: the latest heading duplicated',
    file: 'phase-status',
    expect: /repeats a review number/,
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
    expect: /is not 1\.\.\d+ in order/,
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
    expect: /report a command the battery does not list/,
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
    expect: /carry 2 measured-on labels/,
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
    expect: /says review \d+ and repair \d+/,
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
    expect: /the current position says DONE and the Phase 03 ledger row says/,
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
    expect: /records a result that claims failure for pnpm run test:e2e/,
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
    expect: /records an empty result for pnpm run test:e2e/,
    mutate: (text) =>
      inEvidenceRegion(text, (region) =>
        region.replace(/^\| `pnpm run test:e2e` \|[^\n]*$/m, '| `pnpm run test:e2e` | PASS |  |'),
      ),
  },
  {
    name: 'evidence: a row with the wrong number of cells',
    file: 'phase-status',
    expect: /does not have exactly three cells/,
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
    expect: /unindented H3 repair heading: ### Sixteenth security repair/,
    mutate: (text) =>
      text.replace(
        '## Update protocol',
        '   ### Sixteenth security repair (customer review 16) — `SECURITY_REPAIR_REQUIRED`\n\n' +
          '(indented h3)\n\n## Update protocol',
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
    expect: /carry 0 measured-on labels; there must be exactly one/,
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
    expect: /found 2/,
    mutate: (text) =>
      text.replace(
        '## Current Phase 03 evidence',
        '## Current Phase 03 evidence\n\n(placeholder)\n\n## Current Phase 03 evidence',
      ),
  },
  {
    name: 'canonical section: removed',
    file: 'phase-status',
    expect: /found 0/,
    mutate: (text) => text.replace(/^## Current Phase 03 evidence$/m, '## Evidence'),
  },
  {
    // Derived from the document, not written against whichever repair happens to
    // be current. Two of these fixtures used to name `eleven`/`eleventh`
    // literally and silently stopped mutating anything the moment the count
    // advanced — a negative fixture that changes nothing proves nothing.
    name: 'current position: a stale review number',
    file: 'phase-status',
    expect: /says review \d+ and repair \d+/,
    mutate: (text) => {
      const row = /^\|\s*Customer review number\s*\|\s*(\d+)\s*\|$/m.exec(text);
      if (row === null) throw new Error('no review-number row');
      return text.replace(row[0], `| Customer review number | ${String(Number(row[1]) - 1)} |`);
    },
  },
  {
    name: 'current position: the history runs past the stated repair number',
    file: 'phase-status',
    expect: /the history runs to review \d+/,
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
  const original = fixture.file === 'runbook' ? originalRunbook : originalPhaseStatus;
  const mutated = fixture.mutate(original);
  if (mutated === original) {
    results.push({ name: fixture.name, ok: false, detail: 'fixture did not change the document' });
    failures += 1;
    continue;
  }

  const dir = mkdtempSync(join(tmpdir(), 'prsystem-gov-fixture-'));
  const path = join(dir, 'doc.md');
  try {
    writeFileSync(path, mutated);
    const env = { ...process.env };
    env[fixture.file === 'runbook' ? 'PRSYSTEM_RUNBOOK' : 'PRSYSTEM_PHASE_STATUS'] = path;
    const run = spawnSync(process.execPath, [join(ROOT, 'tools', 'validate-governance.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      env,
    });
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
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
