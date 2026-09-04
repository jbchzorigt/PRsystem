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
import { runGovernanceChecks } from './governance-checks.mjs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNBOOK = join(ROOT, 'docs', 'implementation', 'database-bootstrap-runbook.md');
const PHASE_STATUS = join(ROOT, 'docs', 'implementation', 'phase-status.md');
const EVIDENCE_MANIFEST = join(ROOT, 'docs', 'implementation', 'phase-03-evidence.json');
const PHASE05_MANIFEST = join(ROOT, 'docs', 'implementation', 'phase-05-evidence.json');
const PHASE06_MANIFEST = join(ROOT, 'docs', 'implementation', 'phase-06-evidence.json');
const PHASE07_MANIFEST = join(ROOT, 'docs', 'implementation', 'phase-07-evidence.json');
const originalRunbook = readFileSync(RUNBOOK, 'utf8');
const originalPhaseStatus = readFileSync(PHASE_STATUS, 'utf8');
const originalManifest = readFileSync(EVIDENCE_MANIFEST, 'utf8');
const originalPhase05Manifest = readFileSync(PHASE05_MANIFEST, 'utf8');
const originalPhase06Manifest = readFileSync(PHASE06_MANIFEST, 'utf8');
const originalPhase07Manifest = readFileSync(PHASE07_MANIFEST, 'utf8');

const SOURCES = {
  runbook: { text: originalRunbook, env: 'PRSYSTEM_RUNBOOK', file: 'doc.md' },
  'phase-status': { text: originalPhaseStatus, env: 'PRSYSTEM_PHASE_STATUS', file: 'doc.md' },
  manifest: {
    text: originalManifest,
    env: 'PRSYSTEM_EVIDENCE_MANIFEST',
    file: 'phase-03-evidence.json',
  },
  'phase05-manifest': {
    text: originalPhase05Manifest,
    env: 'PRSYSTEM_PHASE05_MANIFEST',
    file: 'phase-05-evidence.json',
  },
  'phase06-manifest': {
    text: originalPhase06Manifest,
    env: 'PRSYSTEM_PHASE06_MANIFEST',
    file: 'phase-06-evidence.json',
  },
  'phase07-manifest': {
    text: originalPhase07Manifest,
    env: 'PRSYSTEM_PHASE07_MANIFEST',
    file: 'phase-07-evidence.json',
  },
};

/** Applies `change` only inside the Phase 06 evidence region (check 17). */
function inPhase06Region(text, change) {
  const begin = text.indexOf('<!-- phase-06-evidence:begin -->');
  const endMarker = '<!-- phase-06-evidence:end -->';
  const end = text.indexOf(endMarker);
  if (begin < 0 || end < 0) throw new Error('the Phase 06 evidence markers are missing');
  const region = text.slice(begin, end + endMarker.length);
  const changed = change(region);
  if (changed === region) throw new Error('the change did not alter the Phase 06 evidence region');
  return text.slice(0, begin) + changed + text.slice(end + endMarker.length);
}

/** Applies `change` only inside the Phase 07 evidence region (check 17). */
function inPhase07Region(text, change) {
  const begin = text.indexOf('<!-- phase-07-evidence:begin -->');
  const endMarker = '<!-- phase-07-evidence:end -->';
  const end = text.indexOf(endMarker);
  if (begin < 0 || end < 0) throw new Error('the Phase 07 evidence markers are missing');
  const region = text.slice(begin, end + endMarker.length);
  const changed = change(region);
  if (changed === region) throw new Error('the change did not alter the Phase 07 evidence region');
  return text.slice(0, begin) + changed + text.slice(end + endMarker.length);
}

/** Applies `change` only inside the Phase 05 evidence region (check 16). */
function inPhase05Region(text, change) {
  const begin = text.indexOf('<!-- phase-05-evidence:begin -->');
  const endMarker = '<!-- phase-05-evidence:end -->';
  const end = text.indexOf(endMarker);
  if (begin < 0 || end < 0) throw new Error('the Phase 05 evidence markers are missing');
  const region = text.slice(begin, end + endMarker.length);
  const changed = change(region);
  if (changed === region) throw new Error('the change did not alter the Phase 05 evidence region');
  return text.slice(0, begin) + changed + text.slice(end + endMarker.length);
}

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
  // ---------------------------------------- progressed-phase evidence (check 17)
  {
    // The authorization of 2026-09-03 is implementation authorization only. A
    // manifest that wrote ACCEPTED would be declaring a customer decision the
    // governed state does not record.
    name: 'phase 06 manifest: an acceptance the governed state does not record',
    file: 'phase06-manifest',
    expect: /Phase 06 manifest declares acceptance = "ACCEPTED"/,
    mutate: (text) =>
      text.replace('"acceptance": "AWAITING_CUSTOMER_ACCEPTANCE"', '"acceptance": "ACCEPTED"'),
  },
  {
    name: 'phase 06 manifest: a non-zero exit recorded',
    file: 'phase06-manifest',
    expect: /records a non-zero exit code in the Phase 06 manifest/,
    mutate: (text) => text.replace('"exits": [0]', '"exits": [1]'),
  },
  {
    // Phase 06 evidence measured on the tree Phase 05 was accepted at would let
    // that acceptance stand in for a review of Phase 06.
    name: 'phase 06 manifest: measured at the Phase 05 acceptance commit',
    file: 'phase06-manifest',
    expect: /Phase 06 manifest names the Phase 05 acceptance commit as its measured commit/,
    mutate: (text) =>
      text.replace(
        /"measuredAtCommit": "[0-9a-f]{40}"/,
        '"measuredAtCommit": "35314ba210f609269863f0b528bbe827e6a5d3ce"',
      ),
  },
  {
    name: 'phase 06 manifest: a required command removed',
    file: 'phase06-manifest',
    expect: /Phase 06 manifest omits required battery commands: pnpm run test:security/,
    mutate: (text) => {
      const manifest = JSON.parse(text);
      manifest.battery = manifest.battery.filter(
        (entry) => entry.command !== 'pnpm run test:security',
      );
      return `${JSON.stringify(manifest, null, 2)}\n`;
    },
  },
  {
    name: 'phase 06 manifest: the concurrency gate run once instead of three times',
    file: 'phase06-manifest',
    expect:
      /pnpm run test:concurrency must be executed 3 time\(s\); the Phase 06 manifest records 1/,
    mutate: (text) => {
      const manifest = JSON.parse(text);
      const entry = manifest.battery.find((e) => e.command === 'pnpm run test:concurrency');
      entry.executions = 1;
      entry.exits = [0];
      return `${JSON.stringify(manifest, null, 2)}\n`;
    },
  },
  {
    name: 'phase 06 manifest: a key the contract does not declare',
    file: 'phase06-manifest',
    expect: /Phase 06 manifest declares keys \[.*remediationNumber/,
    mutate: (text) => text.replace('"battery":', '"remediationNumber": 1,\n  "battery":'),
  },
  {
    name: 'phase 06 evidence: the region markers removed',
    file: 'phase-status',
    expect: /phase-06-evidence: the begin marker text occurs 0 times/,
    mutate: (text) =>
      text
        .replace('<!-- phase-06-evidence:begin -->\n', '')
        .replace('<!-- phase-06-evidence:end -->\n', ''),
  },
  {
    name: 'phase 06 evidence: a result restated differently from the manifest',
    file: 'phase-status',
    expect: /Phase 06 evidence result for pnpm run test:regression is/,
    mutate: (text) =>
      inPhase06Region(text, (region) =>
        region.replace(/(\| `pnpm run test:regression` \| PASS \| )([^|]+)\|/, '$1altered |'),
      ),
  },
  {
    name: 'phase 06 evidence: the measured commit stated differently from the manifest',
    file: 'phase-status',
    expect: /Phase 06 evidence was measured at/,
    mutate: (text) =>
      inPhase06Region(text, (region) =>
        region.replace(
          /Measured at implementation commit [0-9a-f]{40}/,
          'Measured at implementation commit 0000000000000000000000000000000000000000',
        ),
      ),
  },
  {
    // The authorization of 2026-09-03 is implementation authorization only. A
    // manifest that wrote ACCEPTED would be declaring a customer decision the
    // governed state does not record.
    name: 'phase 07 manifest: an acceptance the governed state does not record',
    file: 'phase07-manifest',
    expect: /Phase 07 manifest declares acceptance = "ACCEPTED"/,
    mutate: (text) =>
      text.replace('"acceptance": "AWAITING_CUSTOMER_ACCEPTANCE"', '"acceptance": "ACCEPTED"'),
  },
  {
    name: 'phase 07 manifest: a non-zero exit recorded',
    file: 'phase07-manifest',
    expect: /records a non-zero exit code in the Phase 07 manifest/,
    mutate: (text) => text.replace('"exits": [0]', '"exits": [1]'),
  },
  {
    // Phase 07 evidence measured on the tree Phase 05 was accepted at would let
    // that acceptance stand in for a review of Phase 07.
    name: 'phase 07 manifest: measured at the Phase 05 acceptance commit',
    file: 'phase07-manifest',
    expect: /Phase 07 manifest names the Phase 05 acceptance commit as its measured commit/,
    mutate: (text) =>
      text.replace(
        /"measuredAtCommit": "[0-9a-f]{40}"/,
        '"measuredAtCommit": "35314ba210f609269863f0b528bbe827e6a5d3ce"',
      ),
  },
  {
    name: 'phase 07 manifest: a required command removed',
    file: 'phase07-manifest',
    expect: /Phase 07 manifest omits required battery commands: pnpm run test:security/,
    mutate: (text) => {
      const manifest = JSON.parse(text);
      manifest.battery = manifest.battery.filter(
        (entry) => entry.command !== 'pnpm run test:security',
      );
      return `${JSON.stringify(manifest, null, 2)}\n`;
    },
  },
  {
    name: 'phase 07 manifest: the concurrency gate run once instead of three times',
    file: 'phase07-manifest',
    expect:
      /pnpm run test:concurrency must be executed 3 time\(s\); the Phase 07 manifest records 1/,
    mutate: (text) => {
      const manifest = JSON.parse(text);
      const entry = manifest.battery.find((e) => e.command === 'pnpm run test:concurrency');
      entry.executions = 1;
      entry.exits = [0];
      return `${JSON.stringify(manifest, null, 2)}\n`;
    },
  },
  {
    name: 'phase 07 manifest: a key the contract does not declare',
    file: 'phase07-manifest',
    expect: /Phase 07 manifest declares keys \[.*remediationNumber/,
    mutate: (text) => text.replace('"battery":', '"remediationNumber": 1,\n  "battery":'),
  },
  {
    name: 'phase 07 evidence: the region markers removed',
    file: 'phase-status',
    expect: /phase-07-evidence: the begin marker text occurs 0 times/,
    mutate: (text) =>
      text
        .replace('<!-- phase-07-evidence:begin -->\n', '')
        .replace('<!-- phase-07-evidence:end -->\n', ''),
  },
  {
    name: 'phase 07 evidence: a result restated differently from the manifest',
    file: 'phase-status',
    expect: /Phase 07 evidence result for pnpm run test:regression is/,
    mutate: (text) =>
      inPhase07Region(text, (region) =>
        region.replace(/(\| `pnpm run test:regression` \| PASS \| )([^|]+)\|/, '$1altered |'),
      ),
  },
  {
    name: 'phase 07 evidence: the measured commit stated differently from the manifest',
    file: 'phase-status',
    expect: /Phase 07 evidence was measured at/,
    mutate: (text) =>
      inPhase07Region(text, (region) =>
        region.replace(
          /Measured at implementation commit [0-9a-f]{40}/,
          'Measured at implementation commit 0000000000000000000000000000000000000000',
        ),
      ),
  },
  {
    // The ledger cannot advance a phase the governed state has not: Phase 08 is
    // the current phase and NOT STARTED until the commit completing it lands.
    name: 'phase status: the current phase advanced by editing the ledger',
    file: 'phase-status',
    expect: /Phase 08 ledger state cell renders/,
    mutate: (text) =>
      text.replace(
        /^(\| 08 \| Availability, guest identity, reception, and stay \| )`NOT STARTED`/m,
        '$1`DONE`',
      ),
  },
  {
    name: 'phase status: the Phase 06 acceptance row claims acceptance',
    file: 'phase-status',
    expect: /Phase 06 acceptance = "`ACCEPTED`"/,
    mutate: (text) =>
      text.replace(
        '| Phase 06 acceptance | `AWAITING_CUSTOMER_ACCEPTANCE` |',
        '| Phase 06 acceptance | `ACCEPTED` |',
      ),
  },
  // ------------------------------------------------ Phase 05 evidence (check 16)
  {
    // The acceptance is the customer's to give and the customer's to withdraw.
    // The manifest may restate the governed `ACCEPTED` and nothing else — it can
    // no more roll the decision back than it could have made it.
    name: 'phase 05 manifest: the acceptance withdrawn by the manifest',
    file: 'phase05-manifest',
    expect: /Phase 05 manifest declares acceptance = "AWAITING_CUSTOMER_ACCEPTANCE"/,
    mutate: (text) =>
      text.replace('"acceptance": "ACCEPTED"', '"acceptance": "AWAITING_CUSTOMER_ACCEPTANCE"'),
  },
  {
    name: 'phase 05 manifest: a non-zero exit recorded',
    file: 'phase05-manifest',
    expect: /records a non-zero exit code in the Phase 05 manifest/,
    mutate: (text) => text.replace('"exits": [0]', '"exits": [1]'),
  },
  {
    // Evidence for an unaccepted phase pointing at a tree the customer already
    // accepted would let the old acceptance stand in for the new review.
    name: 'phase 05 manifest: measured at the Phase 04 acceptance commit',
    file: 'phase05-manifest',
    expect: /names the Phase 04 acceptance commit as its measured commit/,
    mutate: (text) =>
      text.replace(
        /"measuredAtCommit": "[0-9a-f]{40}"/,
        '"measuredAtCommit": "e5fcf19c4164c72106b6d2408f460751ad30685f"',
      ),
  },
  {
    name: 'phase 05 manifest: a required command removed',
    file: 'phase05-manifest',
    expect: /Phase 05 manifest omits required battery commands: pnpm run test:security/,
    mutate: (text) => {
      const manifest = JSON.parse(text);
      manifest.battery = manifest.battery.filter(
        (entry) => entry.command !== 'pnpm run test:security',
      );
      return `${JSON.stringify(manifest, null, 2)}\n`;
    },
  },
  {
    name: 'phase 05 manifest: an unknown key added',
    file: 'phase05-manifest',
    expect: /Phase 05 manifest declares keys \[.*customerAcceptance/,
    mutate: (text) =>
      text.replace(
        '"remediationNumber":',
        '"customerAcceptance": "ACCEPTED",\n  "remediationNumber":',
      ),
  },
  {
    name: 'phase 05 evidence: a result recorded as failed in the document',
    file: 'phase-status',
    expect: /the Phase 05 evidence records a status other than PASS/,
    mutate: (text) =>
      inPhase05Region(text, (region) =>
        region.replace(
          '| `pnpm run test:e2e` | PASS |',
          '| `pnpm run test:e2e` | FAILED — not run |',
        ),
      ),
  },
  {
    name: 'phase 05 evidence: a result restated differently from the manifest',
    file: 'phase-status',
    expect: /the Phase 05 evidence result for pnpm run test:e2e is/,
    mutate: (text) =>
      inPhase05Region(text, (region) => {
        const row = /^\| `pnpm run test:e2e` \| PASS \|[^\n]*$/m.exec(region)?.[0];
        if (row === undefined) throw new Error('no test:e2e result row in the Phase 05 evidence');
        return region.replace(row, '| `pnpm run test:e2e` | PASS | 0 |');
      }),
  },
  {
    name: 'phase 05 evidence: the measured commit restated as another tree',
    file: 'phase-status',
    expect: /the Phase 05 evidence was measured at 0{40}/,
    mutate: (text) =>
      inPhase05Region(text, (region) =>
        region.replace(
          /Measured at implementation commit [0-9a-f]{40}/,
          `Measured at implementation commit ${'0'.repeat(40)}`,
        ),
      ),
  },
  {
    name: 'phase 05 evidence: the region markers removed',
    file: 'phase-status',
    expect: /phase-05-evidence: the begin marker text occurs 0 times/,
    mutate: (text) =>
      text
        .replace('<!-- phase-05-evidence:begin -->\n', '')
        .replace('<!-- phase-05-evidence:end -->\n', ''),
  },
  {
    // A second table inside the region — as a blockquote, so it renders beside
    // the real one — is refused by shape before its rows are read.
    name: 'phase 05 evidence: a second table smuggled into the region',
    file: 'phase-status',
    expect: /phase-05-evidence region carries a blockquote block/,
    mutate: (text) =>
      inPhase05Region(text, (region) =>
        region.replace(
          '<!-- phase-05-evidence:end -->',
          '> | Command | Status | Result |\n> | --- | --- | --- |\n> | `pnpm run test:e2e` | PASS | 0 |\n\n<!-- phase-05-evidence:end -->',
        ),
      ),
  },
  {
    name: 'catalogue: a sub-gate removed',
    file: 'runbook',
    expect: /the catalogue omits SEC-SCHEDULER/,
    mutate: (text) => text.replace('`SEC-SCHEDULER`, ', ''),
  },
  {
    name: 'catalogue: the stated count no longer matches',
    file: 'runbook',
    expect: /says "eighteen" sub-gates, configuration has 19/,
    mutate: (text) =>
      text.replace('aggregates **nineteen** sub-gates', 'aggregates **eighteen** sub-gates'),
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
    expect: /the begin marker text occurs 2 times in the document/,
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
    expect: /the begin marker text occurs 2 times in the document/,
    mutate: (text) =>
      `${text}\n<!-- phase-03-evidence:begin -->\n\nMeasured on the first-repair tree.\n\n` +
      '<!-- phase-03-evidence:end -->\n',
  },
  {
    name: 'evidence: a duplicate begin marker',
    file: 'phase-status',
    expect: /the begin marker text occurs 2 times in the document/,
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
    // Acceptance is the customer's to give and the customer's to withdraw. The
    // document may restate it and nothing else.
    name: 'current position: the acceptance withdrawn',
    file: 'phase-status',
    expect: /states Customer acceptance = /,
    mutate: (text) =>
      text.replace(
        '| Customer acceptance | `ACCEPTED` |',
        '| Customer acceptance | `NOT_ACCEPTED` |',
      ),
  },
  {
    // Phase 04's acceptance is governed the same way Phase 03's is, and for the
    // same reason: it is the customer's to give and the customer's to withdraw.
    // Rolling the row back to the state it was written under before the customer
    // decided would erase a decision that was made.
    name: 'current position: the Phase 04 acceptance withdrawn',
    file: 'phase-status',
    expect: /states Phase 04 acceptance = "`AWAITING_CUSTOMER_ACCEPTANCE`"/,
    mutate: (text) =>
      text.replace(
        '| Phase 04 acceptance | `ACCEPTED` |',
        '| Phase 04 acceptance | `AWAITING_CUSTOMER_ACCEPTANCE` |',
      ),
  },
  {
    // An acceptance names one tree. Repointing it at a later commit would let
    // work the customer never saw arrive under a decision they already made.
    name: 'current position: the Phase 04 acceptance moved to another commit',
    file: 'phase-status',
    expect: /states Phase 04 accepted at = "`0{40}`"/,
    mutate: (text) =>
      text.replace(
        '| Phase 04 accepted at | `e5fcf19c4164c72106b6d2408f460751ad30685f` |',
        `| Phase 04 accepted at | \`${'0'.repeat(40)}\` |`,
      ),
  },
  {
    // Deleting the row rather than editing it: an acceptance with no tree behind
    // it reads as covering whatever HEAD happens to be.
    name: 'current position: the Phase 04 accepted-at row removed',
    file: 'phase-status',
    expect: /the current position has no "Phase 04 accepted at" row/,
    mutate: (text) =>
      text.replace('| Phase 04 accepted at | `e5fcf19c4164c72106b6d2408f460751ad30685f` |\n', ''),
  },
  {
    // Phase 05's acceptance is governed exactly as Phase 03's and Phase 04's
    // are, and withdrawing it in the document would erase a decision the
    // customer made.
    name: 'current position: the Phase 05 acceptance withdrawn',
    file: 'phase-status',
    expect: /states Phase 05 acceptance = "`AWAITING_CUSTOMER_ACCEPTANCE`"/,
    mutate: (text) =>
      text.replace(
        '| Phase 05 acceptance | `ACCEPTED` |',
        '| Phase 05 acceptance | `AWAITING_CUSTOMER_ACCEPTANCE` |',
      ),
  },
  {
    // One acceptance, one tree. Repointing it at a later commit would bring work
    // the customer never saw under a decision they already made.
    name: 'current position: the Phase 05 acceptance moved to another commit',
    file: 'phase-status',
    expect: /states Phase 05 accepted at = "`0{40}`"/,
    mutate: (text) =>
      text.replace(
        '| Phase 05 accepted at | `35314ba210f609269863f0b528bbe827e6a5d3ce` |',
        `| Phase 05 accepted at | \`${'0'.repeat(40)}\` |`,
      ),
  },
  {
    // Deleting the row rather than editing it, as for Phase 04: an acceptance
    // with no tree behind it reads as covering whatever HEAD happens to be.
    name: 'current position: the Phase 05 accepted-at row removed',
    file: 'phase-status',
    expect: /the current position has no "Phase 05 accepted at" row/,
    mutate: (text) =>
      text.replace('| Phase 05 accepted at | `35314ba210f609269863f0b528bbe827e6a5d3ce` |\n', ''),
  },
  {
    // Reading the acceptance as authorization for what comes next, in both cells
    // at once. Each is asserted against the governed state independently rather
    // than against the other, so agreeing with itself buys the edit nothing; the
    // check refuses at the first of the two, and the ledger cell on its own is
    // the fixture above.
    name: 'coordinated: the acceptance used to start Phase 05',
    file: 'phase-status',
    expect: /states Phase state = "`IN PROGRESS`[^"]*"; it must name exactly one state/,
    mutate: (text) =>
      text
        .replace('| Phase state | `NOT STARTED`', '| Phase state | `IN PROGRESS`')
        .replace(/^(\| 06 \|[^|]*\| )`NOT STARTED`/m, '$1`IN PROGRESS`'),
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
    name: 'current position: the Phase 03 state disagrees with the ledger',
    file: 'phase-status',
    expect: /states Phase 03 state = /,
    mutate: (text) =>
      text.replace(
        '| Phase 03 state | `DONE` |',
        '| Phase 03 state | `SECURITY_REPAIR_REQUIRED` |',
      ),
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
      text.replace('| Phase 03 state | `DONE` |', '| Phase 03 state | `DONE` | extra |'),
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
    expect: /raw HTML is not an approved boundary marker/,
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
    expect: /raw HTML is not an approved boundary marker: <h3>/,
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
    expect: /raw HTML is not an approved boundary marker: <!-- ###/,
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
    // Acceptance is the customer's decision, in both directions. The document
    // could not vote itself done, and now that it is done it may not reopen
    // itself either — not even with the manifest, the position and the ledger
    // all saying so together.
    name: 'coordinated: the acceptance rolled back in the manifest, the position and the ledger',
    files: ['phase-status', 'manifest'],
    expect:
      /declares acceptedPhaseState = "SECURITY_REPAIR_REQUIRED"; the governed state is "DONE"/,
    mutate: (sources) => {
      const manifest = JSON.parse(sources.manifest);
      manifest.acceptedPhaseState = 'SECURITY_REPAIR_REQUIRED';
      return {
        'phase-status': sources['phase-status']
          .replace('| Phase 03 state | `DONE` |', '| Phase 03 state | `SECURITY_REPAIR_REQUIRED` |')
          .replace(/^(\| 03 \| Platform kernel \| )`DONE`/m, '$1`SECURITY_REPAIR_REQUIRED`'),
        manifest: `${JSON.stringify(manifest, null, 2)}\n`,
      };
    },
  },
  {
    // Starting the next phase is an authorization, not an edit.
    name: 'current position: the current phase advanced past the governed one',
    file: 'phase-status',
    expect: /states Current phase = "09 [^"]*"; the governed value is "08 — Availability/,
    mutate: (text) =>
      text.replace(
        '| Current phase | 08 — Availability, guest identity, reception, and stay |',
        '| Current phase | 09 — Cleaner and checkout coordination |',
      ),
  },
  {
    // A completed phase is governed the same way the current one is: the
    // document may state it and nothing else. Rolling Phase 04 back to NOT
    // STARTED would erase a phase the programme actually finished.
    name: 'governed: a completed phase rolled back in the ledger',
    file: 'phase-status',
    expect: /Phase 04 ledger state cell renders "`NOT STARTED`"/,
    mutate: (text) => text.replace(/^(\| 04 \|[^|]*\| )`DONE`/m, '$1`NOT STARTED`'),
  },
  {
    name: 'governed: a completed phase rolled back in the current position',
    file: 'phase-status',
    expect: /states Phase 04 state = "`IN PROGRESS`"; the governed value is "`DONE`"/,
    mutate: (text) =>
      text.replace('| Phase 04 state | `DONE` |', '| Phase 04 state | `IN PROGRESS` |'),
  },
  {
    name: 'coordinated: the current phase quietly starts in the ledger',
    file: 'phase-status',
    expect: /Phase 08 ledger state cell renders "`IN PROGRESS`"/,
    mutate: (text) => text.replace(/^(\| 08 \|[^|]*\| )`NOT STARTED`/m, '$1`IN PROGRESS`'),
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
    mutate: (json) => json.replace('{\n  "acceptedPhase"', '{\n  "extra": 1,\n  "acceptedPhase"'),
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
    // A container is not a hiding place. Only top-level tokens were inspected,
    // so a table, a heading or raw HTML inside a blockquote rendered normally
    // and was never looked at.
    name: 'nested: a blockquoted conflicting evidence table',
    file: 'phase-status',
    expect: /results hold 2 tables; there must be exactly one/,
    mutate: (text) =>
      text.replace(
        '<!-- phase-03-evidence:end -->',
        '> | Command | Status | Result |\n> | --- | --- | --- |\n' +
          '> | `pnpm run test:e2e` | PASS | 0 |\n\n<!-- phase-03-evidence:end -->',
      ),
  },
  {
    name: 'nested: a blockquoted duplicate Current position table',
    file: 'phase-status',
    expect: /current position holds 2 tables; there must be exactly one/,
    mutate: (text) =>
      text.replace(
        '## Current position',
        '## Current position\n\n> | Field | Value |\n> | --- | --- |\n> | Phase state | `DONE` |',
      ),
  },
  {
    name: 'nested: a blockquoted repair heading',
    file: 'phase-status',
    expect: /a repair heading is nested inside another block/,
    mutate: (text) =>
      text.replace(
        '## Update protocol',
        '> ### Eighteenth security repair (customer review 18) — `SECURITY_REPAIR_REQUIRED`\n\n' +
          '## Update protocol',
      ),
  },
  {
    name: 'nested: a blockquoted raw HTML heading',
    file: 'phase-status',
    expect: /raw HTML is not an approved boundary marker: <h3>/,
    mutate: (text) =>
      text.replace(
        '## Update protocol',
        '> <h3>Eighteenth security repair (customer review 18)</h3>\n\n## Update protocol',
      ),
  },
  {
    // A marker has exactly one home. Found by `indexOf`, the same text written
    // in a fenced code block was a second boundary.
    name: 'markers: the marker literal inside a fenced code block',
    file: 'phase-status',
    expect: /the begin marker text occurs 2 times in the document/,
    mutate: (text) =>
      text.replace(
        '## Update protocol',
        '```\n<!-- phase-03-evidence:begin -->\n<!-- phase-03-evidence:end -->\n```\n\n' +
          '## Update protocol',
      ),
  },
  {
    // A link title is not visible text. The correct label written there and a
    // stale one in the prose is one label and one decoy, the other way round
    // from how the raw source reads.
    name: 'visible: the correct label only in a link title',
    file: 'phase-status',
    expect: /measured on the first-repair tree \(1\); the manifest declares/,
    mutate: (text) => {
      const label = /^Measured on the [a-z]+-repair tree[^\n]*$/m.exec(text)?.[0];
      if (label === undefined) throw new Error('no measured-on label');
      return text.replace(
        label,
        `See [the tree](https://example.invalid "${label}") for details.\n` +
          'Measured on the first-repair tree. Every command exited 0.',
      );
    },
  },
  {
    name: 'visible: an entity-encoded stale label beside the correct one',
    file: 'phase-status',
    expect: /carry 2 visible measured-on labels/,
    mutate: (text) => {
      const label = /^Measured on the [a-z]+-repair tree[^\n]*$/m.exec(text)?.[0];
      if (label === undefined) throw new Error('no measured-on label');
      return text.replace(
        label,
        `Measured on the &#102;irst-repair tree. Every command exited 0.\n${label}`,
      );
    },
  },
  {
    name: 'visible: an entity-encoded duplicate Current position heading',
    file: 'phase-status',
    expect: /there are 2 visible "Current position" H2 headings/,
    mutate: (text) =>
      text.replace(
        '## Current position',
        '## Current &#112;osition\n\n(decoy)\n\n## Current position',
      ),
  },
  {
    // The link's destination, not the anchor appearing somewhere in the cell.
    name: 'ledger: the anchor only in a link title, pointing elsewhere',
    file: 'phase-status',
    expect: /links whose destination is #current-phase-03-evidence; there must be exactly one/,
    mutate: (text) =>
      text.replace(
        '[Current Phase 03 evidence](#current-phase-03-evidence)',
        '[Current Phase 03 evidence](#elsewhere "#current-phase-03-evidence")',
      ),
  },
  {
    name: 'nested: a second canonical evidence H2 after the measured block',
    file: 'phase-status',
    expect: /there are 2 visible "Current Phase 03 evidence" H2 headings/,
    mutate: (text) =>
      text.replace(
        '<!-- phase-03-evidence:end -->',
        '<!-- phase-03-evidence:end -->\n\n## Current Phase 03 evidence\n\n(second)\n',
      ),
  },
  {
    name: 'nested: raw HTML inside the Current position section',
    file: 'phase-status',
    expect: /raw HTML is not an approved boundary marker: <div>/,
    mutate: (text) =>
      text.replace(
        '| Current phase | 08 — Availability, guest identity, reception, and stay |',
        '| Current phase | 08 — Availability, guest identity, reception, and stay |\n\n<div>raw</div>\n',
      ),
  },
  {
    // Every check must read the supplied document. Only check 15 did, so a
    // scratch phase-status with a whole phase deleted from the ledger returned
    // 15 of 15 and the harness was validating the real file while believing it
    // validated a copy.
    name: 'core: Phase 22 deleted from the supplied phase status',
    file: 'phase-status',
    expect: /phase-status\.md ledger: missing phases 22/,
    mutate: (text) => text.replace(/^\| 22 \|[^\n]*\n/m, ''),
  },
  {
    // Every mutable pointer rolled back together. They agreed only with each
    // other, so there was nothing left to disagree with.
    name: 'governed: the measured-on label and its manifest number rolled back',
    files: ['phase-status', 'manifest'],
    expect: /declares measuredOnRepairNumber = \d+; the governed review number is/,
    mutate: (sources) => {
      const manifest = JSON.parse(sources.manifest);
      const previous = manifest.measuredOnRepairNumber - 1;
      manifest.measuredOnRepairNumber = previous;
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
        'eighteenth',
        'nineteenth',
        'twentieth',
      ];
      const label = /^Measured on the ([a-z]+)-repair tree/m.exec(sources['phase-status']);
      if (label === null) throw new Error('no measured-on label');
      return {
        'phase-status': sources['phase-status'].replace(
          label[0],
          `Measured on the ${ORDINALS[previous - 1]}-repair tree`,
        ),
        manifest: `${JSON.stringify(manifest, null, 2)}\n`,
      };
    },
  },
  {
    name: 'governed: the newest review removed and every pointer rolled back',
    files: ['phase-status', 'manifest'],
    expect: /declares customerReviewNumber = \d+; the governed review number is/,
    mutate: (sources) => {
      const manifest = JSON.parse(sources.manifest);
      const previous = manifest.latestRepairNumber - 1;
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
        'eighteenth',
        'nineteenth',
        'twentieth',
      ];
      const newest = String(manifest.latestRepairNumber);
      manifest.customerReviewNumber = previous;
      manifest.latestRepairNumber = previous;
      manifest.measuredOnRepairNumber = previous;
      manifest.repairHistory = manifest.repairHistory.filter((n) => n !== previous + 1);
      let text = sources['phase-status']
        .replace(
          `| Customer review number | ${newest} |`,
          `| Customer review number | ${String(previous)} |`,
        )
        .replace(
          `| Latest implemented repair number | ${newest} |`,
          `| Latest implemented repair number | ${String(previous)} |`,
        )
        .replace(
          /^Measured on the [a-z]+-repair tree/m,
          `Measured on the ${ORDINALS[previous - 1]}-repair tree`,
        );
      const heading = new RegExp(
        '^### [A-Za-z]+ security repair \\(customer review ' + newest + '\\)[^\n]*$',
        'm',
      ).exec(text)?.[0];
      if (heading === undefined) throw new Error('no newest repair heading');
      const from = text.indexOf(heading);
      const to = text.indexOf('## Update protocol');
      text = text.slice(0, from) + text.slice(to);
      return { 'phase-status': text, manifest: `${JSON.stringify(manifest, null, 2)}\n` };
    },
  },
  {
    name: 'governed: the current phase state changed while the ledger stays NOT STARTED',
    file: 'phase-status',
    expect: /states Phase state = "`IN PROGRESS`/,
    mutate: (text) =>
      text.replace('| Phase state | `NOT STARTED`', '| Phase state | `IN PROGRESS`'),
  },
  {
    // The required token stays in place and the row says two things.
    name: 'governed: a bold DONE appended beside the ledger state token',
    file: 'phase-status',
    expect: /ledger state cell renders "`DONE` \*\*SECURITY_REPAIR_REQUIRED\*\*"/,
    mutate: (text) =>
      text.replace(/^(\| 03 \| Platform kernel \| `DONE`)/m, '$1 **SECURITY_REPAIR_REQUIRED**'),
  },
  {
    name: 'governed: the required battery reordered in both sources',
    files: ['phase-status', 'manifest'],
    expect: /lists the required commands in a different order/,
    mutate: (sources) => {
      const manifest = JSON.parse(sources.manifest);
      manifest.battery = [...manifest.battery].reverse();
      const text = sources['phase-status'];
      const open = text.indexOf('```bash\n');
      const close = text.indexOf('```', open + 8);
      const lines = text
        .slice(open + 8, close)
        .split('\n')
        .filter((line) => line.trim() !== '');
      return {
        'phase-status': `${text.slice(0, open + 8)}${[...lines].reverse().join('\n')}\n${text.slice(close)}`,
        manifest: `${JSON.stringify(manifest, null, 2)}\n`,
      };
    },
  },
  {
    // `JSON.parse` keeps the last member of a duplicated name and says nothing.
    name: 'manifest: a duplicated conflicting member name',
    file: 'manifest',
    expect: /names "acceptedPhaseState" twice in the same object/,
    mutate: (json) =>
      json.replace(
        '"acceptedPhaseState": "DONE",',
        '"acceptedPhaseState": "SECURITY_REPAIR_REQUIRED",\n  "acceptedPhaseState": "DONE",',
      ),
  },
  {
    name: 'governed: result prose contradicting the recorded zero exits',
    files: ['phase-status', 'manifest'],
    expect: /exited zero but its recorded result claims otherwise/,
    mutate: (sources) => {
      const manifest = JSON.parse(sources.manifest);
      for (const entry of manifest.battery) {
        if (entry.command === 'pnpm run test:e2e') entry.result = 'FAILED — command was not run';
      }
      return {
        'phase-status': sources['phase-status'].replace(
          /^\| `pnpm run test:e2e` \| PASS \| [^|]*\|$/m,
          '| `pnpm run test:e2e` | PASS | FAILED — command was not run |',
        ),
        manifest: `${JSON.stringify(manifest, null, 2)}\n`,
      };
    },
  },
  {
    // The section span was derived from whatever contained the heading, so a
    // blockquoted H2 governed the blockquote and every containment test then
    // answered about the wrong span.
    name: 'rendered: the Current position H2 blockquoted',
    file: 'phase-status',
    expect: /the "Current position" H2 is nested inside another block/,
    mutate: (text) => text.replace('## Current position', '> ## Current position'),
  },
  {
    name: 'rendered: the Current Phase 03 evidence H2 blockquoted',
    file: 'phase-status',
    expect: /the "Current Phase 03 evidence" H2 is nested inside another block/,
    mutate: (text) =>
      text.replace('## Current Phase 03 evidence', '> ## Current Phase 03 evidence'),
  },
  {
    // A list item's text lives in `items[].tokens`, which the visible-text walk
    // did not reach.
    name: 'rendered: a conflicting measured-on label inside a list',
    file: 'phase-status',
    expect: /carry 2 visible measured-on labels/,
    mutate: (text) => {
      const label = /^Measured on the [a-z]+-repair tree[^\n]*$/m.exec(text)?.[0];
      if (label === undefined) throw new Error('no measured-on label');
      return text.replace(
        label,
        `${label}\n\n- Measured on the first-repair tree. Every command exited 0.`,
      );
    },
  },
  {
    name: 'rendered: a second blockquoted ledger declaring Phase 03 DONE',
    file: 'phase-status',
    expect: /there are 2 rendered phase ledger tables/,
    mutate: (text) =>
      text.replace(
        '## Update protocol',
        '> | # | Phase | State | Migrations | Gates run | Commit |\n' +
          '> | --- | --- | --- | --- | --- | --- |\n' +
          '> | 03 | Platform kernel | `DONE` | — | — | — |\n\n## Update protocol',
      ),
  },
  {
    // `<h3 >…</h3 >` renders as a heading and matches no pattern written for
    // `<h3>…</h3>`. Rather than chase HTML semantics with regexes, the document
    // carries no raw HTML beyond its six boundary comments.
    name: 'rendered: a raw HTML heading with closing-tag whitespace',
    file: 'phase-status',
    expect: /raw HTML is not an approved boundary marker: <h3 >/,
    mutate: (text) =>
      text.replace(
        '## Update protocol',
        '<h3 >Nineteenth security repair (customer review 19)</h3 >\n\n## Update protocol',
      ),
  },
  {
    name: 'rendered: a raw HTML heading whose words are split by inline tags',
    file: 'phase-status',
    expect: /raw HTML is not an approved boundary marker: <h3>/,
    mutate: (text) =>
      text.replace(
        '## Update protocol',
        '<h3>Nineteenth security re<span></span>pair (customer review 19)</h3>\n\n' +
          '## Update protocol',
      ),
  },
  {
    name: 'evidence: the results markers removed',
    file: 'phase-status',
    expect: /phase-03-evidence: the begin marker text occurs 0 times in the document/,
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
    expect: /phase-03-gate-battery: the begin marker text occurs 0 times in the document/,
    mutate: (text) => text.replace('<!-- phase-03-gate-battery:begin -->', ''),
  },
  {
    name: 'ledger: the canonical link removed',
    file: 'phase-status',
    expect: /links whose destination is #current-phase-03-evidence; there must be exactly one/,
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
    expect: /there are 2 visible "Current Phase 03 evidence" H2 headings/,
    mutate: (text) =>
      text.replace(
        '## Current Phase 03 evidence',
        '## Current Phase 03 evidence\n\n(placeholder)\n\n## Current Phase 03 evidence',
      ),
  },
  {
    name: 'canonical section: removed',
    file: 'phase-status',
    expect: /there are 0 visible "Current Phase 03 evidence" H2 headings/,
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
    // The checks are called directly, with the mutated copies named as
    // arguments. Driving the CLI meant the CLI had to accept path overrides from
    // the environment, and that seam redirected the production gate: pointed at
    // clean decoys it reported 15 of 15 while the canonical document said
    // whatever it liked.
    const paths = {
      root: ROOT,
      runbookPath: RUNBOOK,
      phaseStatusPath: PHASE_STATUS,
      manifestPath: EVIDENCE_MANIFEST,
      phase05ManifestPath: PHASE05_MANIFEST,
      phase06ManifestPath: PHASE06_MANIFEST,
      phase07ManifestPath: PHASE07_MANIFEST,
    };
    const KEY = {
      runbook: 'runbookPath',
      'phase-status': 'phaseStatusPath',
      manifest: 'manifestPath',
      'phase05-manifest': 'phase05ManifestPath',
      'phase06-manifest': 'phase06ManifestPath',
      'phase07-manifest': 'phase07ManifestPath',
    };
    for (const name of names) {
      const path = join(dir, SOURCES[name].file);
      writeFileSync(path, mutatedAll[name]);
      paths[KEY[name]] = path;
    }
    let outcome;
    try {
      outcome = runGovernanceChecks(paths);
    } catch (error) {
      outcome = {
        results: [{ id: '0', title: 'the checks threw', ok: false, detail: String(error) }],
        failed: 1,
      };
    }
    const output = outcome.results
      .map((r) => `[${r.ok ? 'PASS' : 'FAIL'}] ${r.id}. ${r.title}  ${r.detail}`)
      .join('\n');
    if (process.env['PRSYSTEM_FIXTURE_VERBOSE'] === '1') {
      const line = output.split('\n').find((l) => l.startsWith('[FAIL]'));
      console.error(`### ${fixture.name} :: ${String(line)}`);
    }
    const rejected = outcome.failed > 0;
    const diagnosed = failedFor(output, fixture.expect);
    results.push({
      name: fixture.name,
      ok: rejected && diagnosed,
      detail: !rejected
        ? 'ACCEPTED — the drift was not caught'
        : diagnosed
          ? `rejected (${String(outcome.failed)} failing check(s))`
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
  ['the Phase 05 manifest', PHASE05_MANIFEST, originalPhase05Manifest],
  ['the Phase 06 manifest', PHASE06_MANIFEST, originalPhase06Manifest],
  ['the Phase 07 manifest', PHASE07_MANIFEST, originalPhase07Manifest],
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

// The production CLI reads no path from the environment.
//
// The decoys are deliberately *invalid*: each would fail if the CLI read it, so
// identical output can only mean it was not read. Byte-identical valid copies
// proved nothing — a redirectable CLI would have produced the same output too.
const DECOY_DIR = mkdtempSync(join(tmpdir(), 'prsystem-gov-decoy-'));
const decoyPhaseStatus = originalPhaseStatus.replace(/^\| 22 \|[^\n]*\n/m, '');
const decoyManifest = originalManifest.replace('"exits": [0]', '"exits": [1]');
const decoyRunbook = originalRunbook.replace('`SEC-SCHEDULER`, ', '');
const decoyPhase05Manifest = originalPhase05Manifest.replace(
  '"acceptance": "ACCEPTED"',
  '"acceptance": "AWAITING_CUSTOMER_ACCEPTANCE"',
);
const decoyPhase06Manifest = originalPhase06Manifest.replace(
  '"acceptance": "AWAITING_CUSTOMER_ACCEPTANCE"',
  '"acceptance": "ACCEPTED"',
);
const decoyPhase07Manifest = originalPhase07Manifest.replace(
  '"acceptance": "AWAITING_CUSTOMER_ACCEPTANCE"',
  '"acceptance": "ACCEPTED"',
);
for (const [label, contents, original] of [
  ['phase status', decoyPhaseStatus, originalPhaseStatus],
  ['manifest', decoyManifest, originalManifest],
  ['runbook', decoyRunbook, originalRunbook],
  ['phase 05 manifest', decoyPhase05Manifest, originalPhase05Manifest],
  ['phase 06 manifest', decoyPhase06Manifest, originalPhase06Manifest],
  ['phase 07 manifest', decoyPhase07Manifest, originalPhase07Manifest],
]) {
  const changed = contents !== original;
  results.push({
    name: `control: the ${label} decoy is a document that would fail`,
    ok: changed,
    detail: changed ? 'differs from the canonical document' : 'THE DECOY IS UNCHANGED',
  });
  if (!changed) failures += 1;
}
writeFileSync(join(DECOY_DIR, 'doc.md'), decoyPhaseStatus);
writeFileSync(join(DECOY_DIR, 'phase-03-evidence.json'), decoyManifest);
writeFileSync(join(DECOY_DIR, 'runbook.md'), decoyRunbook);
writeFileSync(join(DECOY_DIR, 'phase-05-evidence.json'), decoyPhase05Manifest);
writeFileSync(join(DECOY_DIR, 'phase-06-evidence.json'), decoyPhase06Manifest);
writeFileSync(join(DECOY_DIR, 'phase-07-evidence.json'), decoyPhase07Manifest);

// And the decoys really would fail, read through the core the CLI uses.
for (const [label, paths, expected] of [
  ['phase status', { phaseStatusPath: join(DECOY_DIR, 'doc.md') }, /missing phases 22/],
  [
    'manifest',
    { manifestPath: join(DECOY_DIR, 'phase-03-evidence.json') },
    /records a non-zero exit code/,
  ],
  ['runbook', { runbookPath: join(DECOY_DIR, 'runbook.md') }, /the catalogue omits SEC-SCHEDULER/],
  [
    'phase 05 manifest',
    { phase05ManifestPath: join(DECOY_DIR, 'phase-05-evidence.json') },
    /Phase 05 manifest declares acceptance = "AWAITING_CUSTOMER_ACCEPTANCE"/,
  ],
  [
    'phase 06 manifest',
    { phase06ManifestPath: join(DECOY_DIR, 'phase-06-evidence.json') },
    /Phase 06 manifest declares acceptance = "ACCEPTED"/,
  ],
  [
    'phase 07 manifest',
    { phase07ManifestPath: join(DECOY_DIR, 'phase-07-evidence.json') },
    /Phase 07 manifest declares acceptance = "ACCEPTED"/,
  ],
]) {
  const outcome = runGovernanceChecks({
    root: ROOT,
    runbookPath: RUNBOOK,
    phaseStatusPath: PHASE_STATUS,
    manifestPath: EVIDENCE_MANIFEST,
    phase05ManifestPath: PHASE05_MANIFEST,
    phase06ManifestPath: PHASE06_MANIFEST,
    phase07ManifestPath: PHASE07_MANIFEST,
    ...paths,
  });
  const rejected = outcome.results.some((r) => !r.ok && expected.test(r.detail));
  results.push({
    name: `control: the ${label} decoy is rejected when it is actually read`,
    ok: rejected,
    detail: rejected ? 'rejected' : 'ACCEPTED — the decoy would not have failed',
  });
  if (!rejected) failures += 1;
}

for (const [name, value] of [
  ['PRSYSTEM_PHASE_STATUS', join(DECOY_DIR, 'doc.md')],
  ['PRSYSTEM_EVIDENCE_MANIFEST', join(DECOY_DIR, 'phase-03-evidence.json')],
  ['PRSYSTEM_RUNBOOK', join(DECOY_DIR, 'runbook.md')],
  ['PRSYSTEM_PHASE05_MANIFEST', join(DECOY_DIR, 'phase-05-evidence.json')],
  ['PRSYSTEM_PHASE06_MANIFEST', join(DECOY_DIR, 'phase-06-evidence.json')],
  ['PRSYSTEM_PHASE07_MANIFEST', join(DECOY_DIR, 'phase-07-evidence.json')],
]) {
  const run = spawnSync(process.execPath, [join(ROOT, 'tools', 'validate-governance.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, [name]: value },
  });
  const same = run.stdout === control.stdout && run.status === control.status;
  results.push({
    name: `CLI: ${name} does not redirect governance validation`,
    ok: same && run.status === 0,
    detail: same
      ? 'identical to the unset run, and still passing'
      : 'the output changed — the variable was read',
  });
  if (!same || run.status !== 0) failures += 1;
}
rmSync(DECOY_DIR, { recursive: true, force: true });
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
