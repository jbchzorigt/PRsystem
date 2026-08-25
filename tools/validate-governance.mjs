#!/usr/bin/env node
// Governance validation for the PRsystem implementation plan.
// Standing gate: run at the end of every phase (build-plan.md §5).
//
//   node tools/validate-governance.mjs
//
// Exit code 0 = all checks pass, 1 = at least one check failed.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');
const IMPL = join(DOCS, 'implementation');

const PHASE_MIN = 1;
const PHASE_MAX = 23;
const EXPECTED_DEC_COUNT = 279;
const EXPECTED_SOURCE_DOCS = 27;

const read = (p) => readFileSync(p, 'utf8');
const buildPlan = read(join(IMPL, 'build-plan.md'));
const phaseStatus = read(join(IMPL, 'phase-status.md'));
const traceability = read(join(IMPL, 'requirements-traceability.md'));
const extGates = read(join(IMPL, 'external-integration-gates.md'));
const assumptions = read(join(IMPL, 'assumptions-and-conflicts.md'));
const claudeMd = read(join(ROOT, 'CLAUDE.md'));

const results = [];
const check = (id, title, fn) => {
  try {
    const detail = fn();
    results.push({ id, title, ok: true, detail });
  } catch (err) {
    results.push({ id, title, ok: false, detail: err.message });
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ---------------------------------------------------------------- parse DECs
// Traceability rows: | <FAMILY>-DEC-<NNN> | <subject> | <NN> | <STATUS> |
const decRowRe = /^\|\s*([A-Z]+-DEC-\d{3})\s*\|\s*([^|]+?)\s*\|\s*(\d{2})\s*\|\s*([A-Z]+)\s*\|\s*$/gm;
const decRows = [...traceability.matchAll(decRowRe)].map((m) => ({
  id: m[1],
  subject: m[2],
  phase: Number(m[3]),
  status: m[4],
}));

// ------------------------------------------------------- parse phase numbers
const planHeadingPhases = [...buildPlan.matchAll(/^### Phase (\d{2}) — /gm)].map((m) => Number(m[1]));
const planTablePhases = [...buildPlan.matchAll(/^\|\s*(\d{2})\s*\|\s*[^|]+\|\s*[^|]*\|\s*\d+\s*\|\s*$/gm)]
  .map((m) => Number(m[1]));
const statusLedgerPhases = [
  ...phaseStatus.matchAll(/^\|\s*(\d{2})\s*\|\s*[^|]+\|\s*`[A-Z ]+`\s*\|/gm),
].map((m) => Number(m[1]));

const dupes = (arr) => {
  const seen = new Set();
  const dup = new Set();
  for (const v of arr) (seen.has(v) ? dup : seen).add(v);
  return [...dup];
};
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const missing = (arr, want) => want.filter((v) => !arr.includes(v));

// -------------------------------------------------------------- check 1..9
check('1', 'All 27 source documents are represented', () => {
  const sourceDocs = readdirSync(DOCS)
    .filter((f) => /^\d{2}-.*\.md$/.test(f))
    .sort();
  assert(
    sourceDocs.length === EXPECTED_SOURCE_DOCS,
    `found ${sourceDocs.length} source documents in docs/, expected ${EXPECTED_SOURCE_DOCS}`,
  );
  const unreferenced = sourceDocs.filter((f) => !traceability.includes(f));
  assert(
    unreferenced.length === 0,
    `not referenced in requirements-traceability.md: ${unreferenced.join(', ')}`,
  );
  return `${sourceDocs.length}/${EXPECTED_SOURCE_DOCS} documents present and referenced`;
});

check('2', 'All discovered DEC IDs are unique', () => {
  const ids = decRows.map((r) => r.id);
  const dup = dupes(ids);
  assert(dup.length === 0, `duplicate DEC rows: ${dup.join(', ')}`);
  assert(
    ids.length === EXPECTED_DEC_COUNT,
    `parsed ${ids.length} DEC rows, expected ${EXPECTED_DEC_COUNT}`,
  );
  // Family contiguity: every family must run 001..N with no gaps.
  const byFamily = new Map();
  for (const id of ids) {
    const [, fam, num] = id.match(/^([A-Z]+)-DEC-(\d{3})$/);
    if (!byFamily.has(fam)) byFamily.set(fam, []);
    byFamily.get(fam).push(Number(num));
  }
  for (const [fam, nums] of byFamily) {
    nums.sort((a, b) => a - b);
    const want = range(1, nums.length);
    assert(
      nums.every((n, i) => n === want[i]),
      `family ${fam}-DEC is not contiguous 001..${nums.length}: ${nums.join(',')}`,
    );
  }
  return `${ids.length} unique DEC IDs across ${byFamily.size} contiguous families`;
});

check('3', 'Every DEC is assigned to exactly one phase in 01..23', () => {
  const byId = new Map();
  for (const r of decRows) {
    if (!byId.has(r.id)) byId.set(r.id, new Set());
    byId.get(r.id).add(r.phase);
  }
  const multi = [...byId.entries()].filter(([, ph]) => ph.size !== 1);
  assert(multi.length === 0, `assigned to multiple phases: ${multi.map(([id]) => id).join(', ')}`);
  const outOfRange = decRows.filter((r) => r.phase < PHASE_MIN || r.phase > PHASE_MAX);
  assert(
    outOfRange.length === 0,
    `phase out of 01..23: ${outOfRange.map((r) => `${r.id}→${r.phase}`).join(', ')}`,
  );
  const load = new Map();
  for (const r of decRows) load.set(r.phase, (load.get(r.phase) ?? 0) + 1);
  const total = [...load.values()].reduce((a, b) => a + b, 0);
  assert(total === EXPECTED_DEC_COUNT, `phase load sums to ${total}, expected ${EXPECTED_DEC_COUNT}`);
  return `${byId.size} DECs, one phase each, load sums to ${total}`;
});

check('4', 'Phases 01..23 exist exactly once in build-plan.md and phase-status.md', () => {
  const want = range(PHASE_MIN, PHASE_MAX);
  for (const [label, arr] of [
    ['build-plan.md phase table', planTablePhases],
    ['build-plan.md phase headings', planHeadingPhases],
    ['phase-status.md ledger', statusLedgerPhases.filter((p) => p !== 0)],
  ]) {
    const dup = dupes(arr);
    assert(dup.length === 0, `${label}: duplicated phases ${dup.join(', ')}`);
    const miss = missing(arr, want);
    assert(miss.length === 0, `${label}: missing phases ${miss.join(', ')}`);
    const extra = arr.filter((p) => !want.includes(p));
    assert(extra.length === 0, `${label}: unexpected phases ${extra.join(', ')}`);
  }
  assert(
    statusLedgerPhases.includes(0),
    'phase-status.md ledger is missing the phase 00 row',
  );
  return `01..23 present exactly once in all three listings (plus phase 00 in the ledger)`;
});

check('5', 'EXT-01..EXT-11 each exist exactly once in the gate register', () => {
  const rows = [...extGates.matchAll(/^\|\s*(EXT-\d{2})\s*\|/gm)].map((m) => m[1]);
  const dup = dupes(rows);
  assert(dup.length === 0, `duplicate register rows: ${dup.join(', ')}`);
  const want = range(1, 11).map((n) => `EXT-${String(n).padStart(2, '0')}`);
  const miss = want.filter((id) => !rows.includes(id));
  assert(miss.length === 0, `missing register rows: ${miss.join(', ')}`);
  const extra = rows.filter((id) => !want.includes(id));
  assert(extra.length === 0, `unexpected register rows: ${extra.join(', ')}`);
  return `${rows.length} gates, EXT-01..EXT-11, one register row each`;
});

check('6', 'No requirement mapping references a nonexistent phase', () => {
  const declared = new Set(planHeadingPhases);
  const docs = [
    ['build-plan.md', buildPlan],
    ['phase-status.md', phaseStatus],
    ['requirements-traceability.md', traceability],
    ['external-integration-gates.md', extGates],
    ['assumptions-and-conflicts.md', assumptions],
  ];

  // (a) DEC mappings.
  const bad = decRows.filter((r) => !declared.has(r.phase));
  assert(
    bad.length === 0,
    `phase not declared in build-plan.md: ${bad.map((r) => `${r.id}→${r.phase}`).join(', ')}`,
  );

  // (b) Prose references of the form "Phase NN".
  let prose = 0;
  for (const [name, text] of docs) {
    for (const m of text.matchAll(/\bPhase (\d{2})\b/g)) {
      const n = Number(m[1]);
      prose += 1;
      assert(n === 0 || declared.has(n), `${name} references undeclared "Phase ${m[1]}"`);
    }
  }

  // (c) Table columns whose header names a phase must hold declared phase numbers.
  const PHASE_HEADER = /(phase|established in)/i;
  let cells = 0;
  for (const [name, text] of docs) {
    const lines = text.split('\n');
    let cols = null;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trimStart().startsWith('|')) {
        cols = null;
        continue;
      }
      const parts = line.split('|').slice(1, -1).map((c) => c.trim());
      const isSeparator = parts.every((c) => /^:?-{2,}:?$/.test(c));
      if (isSeparator) continue;
      if (cols === null) {
        // Header row: remember which columns carry phase numbers, skipping any
        // column that holds phase *titles* rather than numbers.
        cols = parts
          .map((c, idx) => (PHASE_HEADER.test(c) ? idx : -1))
          .filter((idx) => idx >= 0);
        continue;
      }
      for (const idx of cols) {
        const cell = parts[idx];
        if (cell === undefined) continue;
        for (const m of cell.matchAll(/\b(\d{2})\b/g)) {
          const n = Number(m[1]);
          if (n === 0) continue;
          cells += 1;
          assert(
            declared.has(n),
            `${name} line ${i + 1}: phase column holds undeclared phase "${m[1]}"`,
          );
        }
      }
    }
  }

  return `${decRows.length} mappings, ${prose} prose references, ${cells} phase-column values all resolve`;
});

check('7', 'Markdown file references resolve', () => {
  const files = [
    ['CLAUDE.md', claudeMd, ROOT],
    ['docs/implementation/build-plan.md', buildPlan, IMPL],
    ['docs/implementation/phase-status.md', phaseStatus, IMPL],
    ['docs/implementation/requirements-traceability.md', traceability, IMPL],
    ['docs/implementation/external-integration-gates.md', extGates, IMPL],
    ['docs/implementation/assumptions-and-conflicts.md', assumptions, IMPL],
  ];
  const broken = [];
  let checked = 0;
  for (const [name, text, base] of files) {
    for (const m of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      checked += 1;
      const p = resolve(base, target.split('#')[0]);
      if (!existsSync(p)) broken.push(`${name} → ${target}`);
    }
  }
  assert(broken.length === 0, `broken links: ${broken.join('; ')}`);
  // Paths named in backticks inside CLAUDE.md §0 must also exist.
  for (const rel of [
    'docs/implementation/build-plan.md',
    'docs/implementation/phase-status.md',
    'docs/implementation/requirements-traceability.md',
    'docs/implementation/external-integration-gates.md',
    'docs/implementation/assumptions-and-conflicts.md',
  ]) {
    assert(existsSync(join(ROOT, rel)), `CLAUDE.md names a missing file: ${rel}`);
    assert(claudeMd.includes(relative('docs/implementation', rel) || rel.split('/').pop()),
      `CLAUDE.md does not name ${rel}`);
  }
  return `${checked} relative links resolve; all five governance documents named in CLAUDE.md exist`;
});

// ------------------------------------------------------------------- report
let failed = 0;
const width = Math.max(...results.map((r) => r.title.length));
for (const r of results) {
  if (!r.ok) failed += 1;
  const mark = r.ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${r.id}. ${r.title.padEnd(width)}  ${r.detail}`);
}
console.log(
  `\n${results.length - failed}/${results.length} checks passed` +
    (failed ? `, ${failed} FAILED` : ''),
);
process.exit(failed ? 1 : 0);
