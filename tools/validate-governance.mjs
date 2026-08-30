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
import { SUB_GATES } from './gate-sec-config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Overridable so the negative-fixture harness can point these two checks at a
// mutated *copy* without touching the real document.
const RUNBOOK_PATH =
  process.env['PRSYSTEM_RUNBOOK'] ??
  join(ROOT, 'docs', 'implementation', 'database-bootstrap-runbook.md');
const PHASE_STATUS_PATH =
  process.env['PRSYSTEM_PHASE_STATUS'] ?? join(ROOT, 'docs', 'implementation', 'phase-status.md');
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
const decRowRe =
  /^\|\s*([A-Z]+-DEC-\d{3})\s*\|\s*([^|]+?)\s*\|\s*(\d{2})\s*\|\s*([A-Z]+)\s*\|\s*$/gm;
const decRows = [...traceability.matchAll(decRowRe)].map((m) => ({
  id: m[1],
  subject: m[2],
  phase: Number(m[3]),
  status: m[4],
}));

// ------------------------------------------------------- parse phase numbers
const planHeadingPhases = [...buildPlan.matchAll(/^### Phase (\d{2}) — /gm)].map((m) =>
  Number(m[1]),
);
const planTablePhases = [
  ...buildPlan.matchAll(/^\|\s*(\d{2})\s*\|\s*[^|]+\|\s*[^|]*\|\s*\d+\s*\|\s*$/gm),
].map((m) => Number(m[1]));
const statusLedgerPhases = [
  // The state vocabulary includes underscored states such as
  // SECURITY_REPAIR_REQUIRED, so the class is not letters and spaces alone.
  ...phaseStatus.matchAll(/^\|\s*(\d{2})\s*\|\s*[^|]+\|\s*\*{0,2}`[A-Z_ ]+`\*{0,2}\s*\|/gm),
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
  assert(
    total === EXPECTED_DEC_COUNT,
    `phase load sums to ${total}, expected ${EXPECTED_DEC_COUNT}`,
  );
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
  assert(statusLedgerPhases.includes(0), 'phase-status.md ledger is missing the phase 00 row');
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
      const parts = line
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
      const isSeparator = parts.every((c) => /^:?-{2,}:?$/.test(c));
      if (isSeparator) continue;
      if (cols === null) {
        // Header row: remember which columns carry phase numbers, skipping any
        // column that holds phase *titles* rather than numbers.
        cols = parts.map((c, idx) => (PHASE_HEADER.test(c) ? idx : -1)).filter((idx) => idx >= 0);
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
  const archDir = join(DOCS, 'architecture');
  if (existsSync(archDir)) {
    for (const f of readdirSync(archDir).filter((n) => n.endsWith('.md'))) {
      files.push([`docs/architecture/${f}`, read(join(archDir, f)), archDir]);
    }
    const adrDir = join(archDir, 'adr');
    if (existsSync(adrDir)) {
      for (const f of readdirSync(adrDir).filter((n) => n.endsWith('.md'))) {
        files.push([`docs/architecture/adr/${f}`, read(join(adrDir, f)), adrDir]);
      }
    }
  }
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
    assert(
      claudeMd.includes(relative('docs/implementation', rel) || rel.split('/').pop()),
      `CLAUDE.md does not name ${rel}`,
    );
  }
  return `${checked} relative links resolve; all five governance documents named in CLAUDE.md exist`;
});

// ------------------------------------------- Phase 01 architecture checks
const ARCH = join(DOCS, 'architecture');
const hasArch = existsSync(ARCH);

if (hasArch) {
  const archIndex = read(join(ARCH, 'README.md'));
  const adrIndex = read(join(ARCH, 'adr', 'README.md'));
  const decMap = read(join(ARCH, '17-dec-control-mapping.md'));
  const portCatalog = read(join(ARCH, '16-external-port-catalog.md'));
  const gateDoc = read(join(ARCH, '14-test-strategy-and-gates.md'));

  check('8', 'Architecture index and ADR index resolve to real documents', () => {
    const wantDocs = readdirSync(ARCH)
      .filter((f) => /^\d{2}-.*\.md$/.test(f))
      .sort();
    assert(
      wantDocs.length === 17,
      `expected 17 numbered architecture documents, found ${wantDocs.length}`,
    );
    const unlisted = wantDocs.filter((f) => !archIndex.includes(f));
    assert(unlisted.length === 0, `not listed in the architecture index: ${unlisted.join(', ')}`);

    const adrFiles = readdirSync(join(ARCH, 'adr'))
      .filter((f) => /^ADR-\d{4}-.*\.md$/.test(f))
      .sort();
    assert(adrFiles.length >= 1, 'no ADRs found');
    const adrUnlisted = adrFiles.filter((f) => !adrIndex.includes(f));
    assert(adrUnlisted.length === 0, `ADRs not listed in the ADR index: ${adrUnlisted.join(', ')}`);
    const nums = adrFiles.map((f) => Number(f.match(/^ADR-(\d{4})/)[1]));
    const wantNums = range(1, nums.length);
    assert(
      nums.every((n, i) => n === wantNums[i]),
      `ADR numbering is not contiguous 0001..${nums.length}: ${nums.join(',')}`,
    );
    return `${wantDocs.length} architecture documents and ${adrFiles.length} contiguous ADRs, all indexed`;
  });

  check('9', 'Every cross-cutting invariant has a named enforcement mechanism', () => {
    // traceability §25 rows: | invariant | sources | established in | enforced by |
    const invRe =
      /^\|\s*([^|]+?)\s*\|\s*([^|]*(?:DEC-\d{3})[^|]*)\s*\|\s*(\d{2})\s*\|\s*([^|]+?)\s*\|\s*$/gm;
    const rows = [...traceability.matchAll(invRe)];
    assert(rows.length >= 10, `parsed only ${rows.length} invariant rows in traceability §25`);
    const missingMech = rows.filter((m) => m[4].trim().length < 3 || m[4].trim() === '—');
    assert(
      missingMech.length === 0,
      `invariants without an enforcement mechanism: ${missingMech.map((m) => m[1]).join('; ')}`,
    );
    const declared = new Set(planHeadingPhases);
    const badPhase = rows.filter((m) => !declared.has(Number(m[3])));
    assert(
      badPhase.length === 0,
      `invariant established in an undeclared phase: ${badPhase.map((m) => m[1]).join('; ')}`,
    );
    return `${rows.length} invariants, each with a mechanism and a declared establishing phase`;
  });

  check('10', 'Every EXT gate has a named port surface or an explicit no-port rationale', () => {
    const want = range(1, 11).map((n) => `EXT-${String(n).padStart(2, '0')}`);
    const missingGate = want.filter((id) => !portCatalog.includes(id));
    assert(missingGate.length === 0, `absent from the port catalog: ${missingGate.join(', ')}`);
    // Each gate row in §4 must name a port or say "no port".
    const rows = [...portCatalog.matchAll(/^\|\s*(EXT-\d{2})\s*\|\s*([^|]+?)\s*\|/gm)];
    assert(rows.length === 11, `port catalog gate table has ${rows.length} rows, expected 11`);
    const unnamed = rows.filter((m) => !/Port|no port/i.test(m[2]));
    assert(
      unnamed.length === 0,
      `gates without a named port or rationale: ${unnamed.map((m) => m[1]).join(', ')}`,
    );
    return `11 gates: ${rows.filter((m) => /Port/.test(m[2])).length} with a typed port, ${rows.filter((m) => /no port/i.test(m[2])).length} policy-only`;
  });

  check('11', 'Every DEC maps to defined controls and gates', () => {
    const controlIds = new Set(
      [...decMap.matchAll(/^\|\s*`?(CTL-[A-Z]+-\d{2})`?\s*\|/gm)].map((m) => m[1]),
    );
    assert(controlIds.size >= 20, `control catalog defines only ${controlIds.size} controls`);
    const gateIds = new Set(
      [...gateDoc.matchAll(/^\|\s*`?(GATE-[A-Z]+)`?\s*\|/gm)].map((m) => m[1]),
    );
    assert(gateIds.size >= 7, `gate catalog defines only ${gateIds.size} gates`);

    const mapRe = /^\|\s*([A-Z]+-DEC-\d{3})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/gm;
    const mapped = new Map();
    for (const m of decMap.matchAll(mapRe)) {
      if (!/CTL-/.test(m[2])) continue; // skip catalog tables
      mapped.set(m[1], { controls: m[2], gates: m[3] });
    }
    const allDecs = decRows.map((r) => r.id);
    const unmapped = allDecs.filter((id) => !mapped.has(id));
    assert(
      unmapped.length === 0,
      `DECs with no control mapping: ${unmapped.slice(0, 10).join(', ')}${unmapped.length > 10 ? ` (+${unmapped.length - 10})` : ''}`,
    );

    const badControl = [];
    const badGate = [];
    for (const [id, { controls, gates }] of mapped) {
      for (const c of controls.matchAll(/CTL-[A-Z]+-\d{2}/g)) {
        if (!controlIds.has(c[0])) badControl.push(`${id}→${c[0]}`);
      }
      for (const g of gates.matchAll(/GATE-[A-Z]+/g)) {
        if (!gateIds.has(g[0])) badGate.push(`${id}→${g[0]}`);
      }
    }
    assert(badControl.length === 0, `undefined controls cited: ${badControl.join(', ')}`);
    assert(badGate.length === 0, `undefined gates cited: ${badGate.join(', ')}`);
    return `${mapped.size}/${allDecs.length} DECs mapped; ${controlIds.size} controls and ${gateIds.size} gates all defined`;
  });

  check('12', 'Every architecture design question is resolved by an ADR', () => {
    const dataModel = read(join(ARCH, '04-logical-data-model.md'));
    const adrIdx = read(join(ARCH, 'adr', 'README.md'));
    const want = ['DM-01', 'DM-02', 'DM-03', 'DM-04'];

    // The data model must present them as resolved, not open.
    assert(
      /##\s*\d+\.\s*Resolved modelling decisions/i.test(dataModel),
      '04-logical-data-model.md still presents design questions as open',
    );
    assert(
      !/##\s*\d+\.\s*Open modelling questions/i.test(dataModel),
      '04-logical-data-model.md still contains an "Open modelling questions" section',
    );

    const adrFiles = readdirSync(join(ARCH, 'adr')).filter((f) => /^ADR-\d{4}-/.test(f));
    const unresolved = [];
    for (const id of want) {
      // Each question must appear in the data model, the ADR index, and be closed by a real ADR.
      if (!dataModel.includes(id)) unresolved.push(`${id}: absent from the data model`);
      if (!adrIdx.includes(id)) unresolved.push(`${id}: absent from the ADR index`);
      const closer = adrFiles.find((f) => read(join(ARCH, 'adr', f)).includes(`**Closes:** ${id}`));
      if (!closer) unresolved.push(`${id}: no ADR declares "**Closes:** ${id}"`);
    }
    assert(unresolved.length === 0, unresolved.join('; '));
    return `${want.length} design questions closed by ADRs, none open`;
  });

  check('13', 'P1 accounting is internally consistent and nothing is falsely closed', () => {
    const nfr = read(join(ARCH, '15-non-functional-targets.md'));

    // Count P1 rows in the register.
    const rows = [...assumptions.matchAll(/^\|\s*(P1-\d{2})\s*\|/gm)].map((m) => m[1]);
    const uniq = new Set(rows);
    assert(
      rows.length === uniq.size,
      `duplicate P1 rows: ${rows.length} rows, ${uniq.size} unique`,
    );
    const total = uniq.size;

    // The stated accounting line must agree with the row count.
    const acct = assumptions.match(
      /\*\*P1 accounting:\*\*\s*(\d+)\s*total\s*·\s*(\d+)\s*pending\s*·\s*(\d+)\s*closed/,
    );
    assert(acct, 'assumptions-and-conflicts.md has no "**P1 accounting:**" line');
    const [, sTotal, sPending, sClosed] = acct.map(Number);
    assert(sTotal === total, `accounting says ${sTotal} total, register has ${total} rows`);
    assert(
      sPending + sClosed === sTotal,
      `accounting is not self-consistent: ${sPending} + ${sClosed} != ${sTotal}`,
    );

    // Every other document that states a P1 count must agree.
    const mismatches = [];
    for (const [name, text] of [
      ['assumptions-and-conflicts.md', assumptions],
      ['phase-status.md', phaseStatus],
      ['build-plan.md', buildPlan],
      ['15-non-functional-targets.md', nfr],
    ]) {
      for (const m of text.matchAll(/(\d+)\s+(?:pending\s+)?P1(?:\s+configuration)?\s+items?/gi)) {
        if (Number(m[1]) !== sPending)
          mismatches.push(`${name}: "${m[0].trim()}" vs ${sPending} pending`);
      }
    }
    assert(mismatches.length === 0, `inconsistent P1 counts — ${mismatches.join('; ')}`);

    // No P1 item may be described as closed by architecture alone.
    const falseClosure = [];
    for (const [name, text] of [
      ['architecture/README.md', read(join(ARCH, 'README.md'))],
      ['15-non-functional-targets.md', nfr],
      ['build-plan.md', buildPlan],
      ['phase-status.md', phaseStatus],
      ['assumptions-and-conflicts.md', assumptions],
    ]) {
      for (const m of text.matchAll(/\b(clos(?:es|ed|ing))\b[^.\n]{0,40}?(P1-\d{2})/gi)) {
        falseClosure.push(`${name}: "${m[0].trim()}"`);
      }
    }
    assert(
      falseClosure.length === 0,
      `P1 item described as closed without an approved DEC — ${falseClosure.join('; ')}`,
    );

    // NFR values must carry the provisional status, including RPO and RTO.
    assert(
      nfr.includes('PROVISIONAL_ARCHITECTURE_DEFAULT'),
      '15-non-functional-targets.md does not mark values PROVISIONAL_ARCHITECTURE_DEFAULT',
    );
    for (const token of ['RPO', 'RTO']) {
      const line = nfr.split('\n').find((l) => l.includes(`| ${token} |`));
      assert(line, `15-non-functional-targets.md has no ${token} row`);
      assert(
        line.includes('PROVISIONAL_ARCHITECTURE_DEFAULT'),
        `${token} row is not marked PROVISIONAL_ARCHITECTURE_DEFAULT`,
      );
    }
    return `${total} P1 items: ${sPending} pending, ${sClosed} closed; NFR values provisional incl. RPO and RTO`;
  });
}

/** The body of a Markdown section, from its exact heading to the next same-level one. */
function section(text, heading) {
  const lines = text.split('\n');
  const level = /^#+/.exec(heading)?.[0].length ?? 0;
  const start = lines.indexOf(heading);
  if (start < 0) return undefined;
  const boundary = new RegExp(`^#{1,${String(level)}} `);
  for (let i = start + 1; i < lines.length; i += 1) {
    if (boundary.test(lines[i])) return lines.slice(start + 1, i).join('\n');
  }
  return lines.slice(start + 1).join('\n');
}

/** The text between two exact HTML comment markers. */
/**
 * The one region bounded by `name`'s markers, with its exact bounds.
 *
 * `indexOf` took the *first* begin and the *first* end, so a correct-looking
 * decoy pair placed earlier in the file supplied the region while the real block
 * inside the canonical section went unread — the same failure as taking the
 * first `aggregates **n** sub-gates` in the runbook. Exactly one of each marker
 * must exist, and the end must follow the begin.
 */
function markedRegion(text, name) {
  const open = `<!-- ${name}:begin -->`;
  const close = `<!-- ${name}:end -->`;
  const at = (marker) => {
    const found = [];
    for (let i = text.indexOf(marker); i >= 0; i = text.indexOf(marker, i + 1)) found.push(i);
    return found;
  };
  const opens = at(open);
  const closes = at(close);
  assert(
    opens.length === 1 && closes.length === 1,
    `${name}: expected exactly one begin marker and one end marker, found ` +
      `${String(opens.length)} and ${String(closes.length)}`,
  );
  assert(closes[0] > opens[0], `${name}: the end marker precedes the begin marker`);
  return {
    body: text.slice(opens[0] + open.length, closes[0]),
    start: opens[0],
    end: closes[0] + close.length,
  };
}

/** The exact character bounds of a section, so containment can be checked. */
function sectionBounds(text, heading) {
  const lines = text.split('\n');
  const level = /^#+/.exec(heading)?.[0].length ?? 0;
  const index = lines.indexOf(heading);
  if (index < 0) return undefined;
  const boundary = new RegExp(`^#{1,${String(level)}} `);
  const offsetOf = (n) => lines.slice(0, n).reduce((sum, line) => sum + line.length + 1, 0);
  for (let i = index + 1; i < lines.length; i += 1) {
    if (boundary.test(lines[i])) return { start: offsetOf(index), end: offsetOf(i) };
  }
  return { start: offsetOf(index), end: text.length };
}

check('14', 'The runbook GATE-SEC catalogue matches tools/gate-sec-config.mjs', () => {
  // Anchored to its own heading. Taking the first `aggregates **n** sub-gates`
  // in the file meant a complete decoy catalogue placed earlier satisfied the
  // check while the real one had lost entries.
  const runbook = readFileSync(RUNBOOK_PATH, 'utf8');
  const catalogue = section(runbook, '### GATE-SEC sub-gate catalogue');
  assert(catalogue !== undefined, 'the runbook has no "### GATE-SEC sub-gate catalogue" section');

  const stated = /aggregates \*\*([a-z]+)\*\* sub-gates/.exec(catalogue)?.[1];
  const configured = SUB_GATES.map((gate) => gate.id).sort();
  const listed = [...new Set([...catalogue.matchAll(/`(SEC-[A-Z-]+)`/g)].map((m) => m[1]))].sort();

  const missing = configured.filter((id) => !listed.includes(id));
  const extra = listed.filter((id) => !configured.includes(id));
  assert(missing.length === 0, `the catalogue omits ${missing.join(', ')}`);
  assert(extra.length === 0, `the catalogue lists unknown sub-gates ${extra.join(', ')}`);

  const words = { sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
  assert(
    stated !== undefined && words[stated] === configured.length,
    `the catalogue says "${String(stated)}" sub-gates, configuration has ${String(configured.length)}`,
  );
  return `${configured.length} sub-gates, catalogue section and configuration agree`;
});

check('15', 'Phase 03 results live in exactly one canonical section', () => {
  const text = readFileSync(PHASE_STATUS_PATH, 'utf8');
  const ANCHOR = '#current-phase-03-evidence';

  const canonical = [...text.matchAll(/^## Current Phase 03 evidence$/gm)];
  assert(
    canonical.length === 1,
    `expected exactly one canonical evidence section, found ${String(canonical.length)}`,
  );
  const evidence = section(text, '## Current Phase 03 evidence');
  assert(evidence !== undefined, 'the canonical evidence section is empty');
  const evidenceBounds = sectionBounds(text, '## Current Phase 03 evidence');
  assert(evidenceBounds !== undefined, 'the canonical evidence section has no bounds');

  // Containment is asserted on the region's exact character bounds, not on the
  // section text merely mentioning a marker. A decoy pair anywhere in the file
  // is refused by `markedRegion`, which requires exactly one of each.
  const within = (region, what) => {
    assert(
      region.start >= evidenceBounds.start && region.end <= evidenceBounds.end,
      `${what} is not inside the canonical evidence section`,
    );
  };

  // The gate battery is bounded by explicit markers and must sit inside the
  // canonical section. Selecting "the first bash block starting with
  // node tools/validate-governance" found one inside the Phase 00 record.
  const battery = markedRegion(text, 'phase-03-gate-battery');
  within(battery, 'the Phase 03 gate battery');

  // The Phase 03 ledger row links to the canonical section and restates nothing.
  const ledgerRow = text.split('\n').find((line) => line.startsWith('| 03 |'));
  assert(ledgerRow !== undefined, 'the phase ledger has no Phase 03 row');
  assert(ledgerRow.includes(ANCHOR), `the Phase 03 ledger row does not link to ${ANCHOR}`);

  const measuredRegion = markedRegion(text, 'phase-03-evidence');
  within(measuredRegion, 'the canonical evidence results');

  // The region must contain the results, not merely a correct-looking label.
  // Marker geometry alone was satisfied by a pair wrapping one true sentence
  // while the real table sat outside them carrying a stale one.
  //
  // Occurrences, not matching lines: two labels written on one line counted as
  // one, and the second could name any tree at all.
  const labels = [...measuredRegion.body.matchAll(/Measured on the ([a-z]+)-repair tree/g)];
  assert(
    labels.length === 1,
    `the canonical evidence results carry ${String(labels.length)} measured-on labels; ` +
      'there must be exactly one',
  );
  const measured = labels[0][1];

  // ------------------------------------------------------------- the battery
  const fences = [...battery.body.matchAll(/^```bash\n([\s\S]*?)^```$/gm)];
  assert(
    fences.length === 1,
    `the Phase 03 gate battery holds ${String(fences.length)} bash blocks; there must be one`,
  );
  const batteryCommands = fences[0][1]
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line !== '');
  assert(batteryCommands.length > 0, 'the Phase 03 gate battery lists no commands');
  const batterySet = new Set(batteryCommands);
  assert(
    batterySet.size === batteryCommands.length,
    `the Phase 03 gate battery lists a command twice: ${batteryCommands.join('; ')}`,
  );

  // ------------------------------------------------------- the results table
  //
  // Every line that looks like a table row is parsed, not the ones a narrow
  // pattern recognised. A row without backticks, a row indented by one space and
  // a row whose cells were swapped all read as prose to a pattern anchored on
  // "| `command` |", and each of them sat beside the real row saying something
  // else.
  const TABLE_LINE = /^ {0,3}\|/;
  const evidenceLines = measuredRegion.body.split('\n');
  const tables = [];
  let current = null;
  for (const line of evidenceLines) {
    if (TABLE_LINE.test(line)) {
      if (current === null) {
        current = [];
        tables.push(current);
      }
      current.push(line);
    } else {
      // Any non-row line ends the table, blank ones included: Markdown needs a
      // blank line between blocks, so two tables separated by one are two
      // tables and not a longer one.
      current = null;
    }
  }
  assert(
    tables.length === 1,
    `the canonical evidence results hold ${String(tables.length)} tables; there must be exactly ` +
      'one',
  );

  /** A table row's cells, or undefined when the line is not a well-formed row. */
  const cellsOf = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return undefined;
    return trimmed.slice(1, -1).split('|');
  };

  const [header, separator, ...dataRows] = tables[0];
  const headerCells = cellsOf(header)?.map((cell) => cell.trim());
  assert(
    headerCells !== undefined && headerCells.join(' | ') === 'Command | Status | Result',
    `the canonical evidence table header is "${String(headerCells?.join(' | '))}"; it must be ` +
      '"Command | Status | Result"',
  );
  const separatorCells = cellsOf(separator ?? '')?.map((cell) => cell.trim());
  assert(
    separatorCells !== undefined &&
      separatorCells.length === 3 &&
      separatorCells.every((cell) => /^-{3,}$/.test(cell)),
    'the canonical evidence table has no three-column separator row',
  );

  const FAILURE_WORDS = /\b(fail|failed|failing|skip|skipped|not run|non-?zero|error)\b/i;
  const byCommand = new Map();
  for (const row of dataRows) {
    const cells = cellsOf(row);
    assert(
      cells !== undefined && cells.length === 3,
      `a result row does not have exactly three cells: ${row.trim().slice(0, 70)}`,
    );
    const [commandCell, statusCell, resultCell] = cells.map((cell) => cell.trim());

    // Exactly one backticked command, and it must be one the battery lists. A
    // row that named the command without backticks was invisible.
    const quoted = [...commandCell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    assert(
      quoted.length === 1,
      `a result row names ${String(quoted.length)} backticked commands: ` +
        `${row.trim().slice(0, 70)}`,
    );
    const command = quoted[0];
    assert(
      batterySet.has(command),
      `the canonical evidence results report a command the battery does not list: ${command}`,
    );
    assert(!byCommand.has(command), `the canonical evidence results carry two rows for ${command}`);

    assert(
      statusCell === 'PASS',
      `the canonical evidence records a status other than PASS: ${command} → ${statusCell}`,
    );
    assert(resultCell !== '', `the canonical evidence records an empty result for ${command}`);
    assert(
      !FAILURE_WORDS.test(resultCell),
      `the canonical evidence records a result that claims failure for ${command}: ${resultCell}`,
    );
    byCommand.set(command, resultCell);
  }

  const unreported = batteryCommands.filter((command) => !byCommand.has(command));
  assert(
    unreported.length === 0,
    `the canonical evidence results have no row for: ${unreported.join('; ')}`,
  );

  // ------------------------------------------------- the current position
  //
  // Explicit rows with unique keys and exact values. The row used to carry
  // prose, and a second contradicting sentence appended to it was shadowed by
  // the first regex match.
  const position = sectionBounds(text, '## Current position');
  assert(position !== undefined, 'there is no "## Current position" section');
  const positionRows = new Map();
  for (const line of text.slice(position.start, position.end).split('\n')) {
    const cells = cellsOf(line);
    if (cells === undefined || cells.length !== 2) continue;
    const key = cells[0].trim();
    if (key === 'Field' || /^-{3,}$/.test(key)) continue;
    assert(!positionRows.has(key), `the current position states "${key}" twice`);
    positionRows.set(key, cells[1].trim());
  }

  const positionValue = (key) => {
    const value = positionRows.get(key);
    assert(value !== undefined, `the current position has no "${key}" row`);
    return value;
  };

  const CARDINALS = {
    seventh: 7,
    eighth: 8,
    ninth: 9,
    tenth: 10,
    eleventh: 11,
    twelfth: 12,
    thirteenth: 13,
    fourteenth: 14,
    fifteenth: 15,
    sixteenth: 16,
    seventeenth: 17,
  };
  const ORDINALS = {
    first: 1,
    second: 2,
    third: 3,
    fourth: 4,
    fifth: 5,
    sixth: 6,
    ...CARDINALS,
  };

  const positionState = /^`([A-Z_]+)`$/.exec(positionValue('Phase state'))?.[1];
  assert(
    positionState !== undefined,
    `the current position phase state is "${positionValue('Phase state')}"; it must be one ` +
      'backticked state and nothing else',
  );
  const acceptance = /^`([A-Z_]+)`$/.exec(positionValue('Customer acceptance'))?.[1];
  assert(
    acceptance === 'NOT_ACCEPTED',
    `the current position states customer acceptance "${String(acceptance)}"; Phase 03 is not ` +
      'accepted and this document does not claim otherwise',
  );
  const reviewNumber = /^(\d+)$/.exec(positionValue('Customer review number'))?.[1];
  const repairNumberText = /^(\d+)$/.exec(positionValue('Latest implemented repair number'))?.[1];
  assert(
    reviewNumber !== undefined && repairNumberText !== undefined,
    'the current position review and repair numbers must each be a bare number',
  );
  const repairNumber = Number(repairNumberText);
  assert(
    Number(reviewNumber) === repairNumber,
    `the current position says review ${reviewNumber} and repair ${repairNumberText}`,
  );

  // One phase state, stated in three places, compared.
  const ledgerState = /^\|\s*03\s*\|[^|]*\|\s*`([A-Z_]+)`/.exec(ledgerRow)?.[1];
  assert(
    ledgerState === positionState,
    `the current position says ${positionState} and the Phase 03 ledger row says ` +
      `${String(ledgerState)}`,
  );
  assert(
    positionState === 'SECURITY_REPAIR_REQUIRED',
    `every repair heading states SECURITY_REPAIR_REQUIRED; the current position says ` +
      `${positionState}`,
  );

  // And the ledger keeps no copy of the review ordinal. Another copy of a moving
  // number is another thing to go stale, which is exactly what it did.
  const ledgerOrdinal = new RegExp(`\\b(${Object.keys(ORDINALS).join('|')})\\b`, 'i').exec(
    ledgerRow,
  );
  assert(
    ledgerOrdinal === null,
    `the Phase 03 ledger row restates the repair ordinal "${String(ledgerOrdinal?.[1])}"; the ` +
      'canonical section is the one place that number is written',
  );

  assert(
    ORDINALS[measured] === repairNumber,
    `the canonical evidence was "measured on the ${measured}-repair tree" (` +
      `${String(ORDINALS[measured])}); the current position names review ` +
      `${String(repairNumber)}`,
  );

  // ------------------------------------------------------- the repair history
  //
  // Every ATX heading at every level, including headings indented by up to three
  // spaces, which Markdown still renders as headings. A malformed `####` record
  // behind an empty canonical `###` decoy, an `##` record and an indented `###`
  // record were each invisible to a rule that only looked at unindented `### `.
  const CANONICAL_HEADING =
    /^### ([A-Za-z]+) security repair \(customer review (\d+)\) — `SECURITY_REPAIR_REQUIRED`$/;
  const DECLARED_SECTION_HEADINGS = new Set([
    '### Remaining blockers',
    '### GATE-SEC sub-gate counts',
  ]);
  const DESCRIBES_A_REPAIR = /\brepair\b|\bcustomer review\b/i;

  const history = markedRegion(text, 'phase-03-repair-history');
  const headings = [...text.matchAll(/^ {0,3}#{1,6} [^\n]*$/gm)].map((match) => ({
    heading: match[0],
    inside: match.index >= history.start && match.index < history.end,
  }));

  const sections = [];
  for (const entry of headings) {
    const canonical = CANONICAL_HEADING.test(entry.heading);
    if (canonical) {
      assert(
        entry.inside,
        `a repair heading sits outside the bounded repair history: ${entry.heading.trim()}`,
      );
      const parsed = CANONICAL_HEADING.exec(entry.heading);
      sections.push({
        heading: entry.heading,
        word: parsed[1].toLowerCase(),
        number: Number(parsed[2]),
      });
      continue;
    }
    // Not canonical. It may not describe a repair record at any level, indented
    // or not, inside the history region or outside it.
    assert(
      !DESCRIBES_A_REPAIR.test(entry.heading),
      `a heading describes a repair or a customer review but is not a canonical, unindented ` +
        `H3 repair heading: ${entry.heading.trim()}`,
    );
    if (!entry.inside) continue;
    if (!entry.heading.startsWith('### ')) continue; // a sub-heading of a record
    assert(
      DECLARED_SECTION_HEADINGS.has(entry.heading.trim()),
      `a heading in the repair history is neither a canonical repair heading nor a declared ` +
        `section heading: ${entry.heading.trim()}`,
    );
  }
  assert(sections.length > 0, 'there are no numbered repair sections');

  for (const entry of sections) {
    assert(
      ORDINALS[entry.word] === entry.number,
      `a repair heading disagrees with its own number: ${entry.heading.trim()}`,
    );
  }

  // Unique, contiguous and ascending from 1 through the current review. A
  // duplicate latest heading, a gap, or a reordered history each passed while
  // only the last entry was read.
  const numbers = sections.map((entry) => entry.number);
  assert(
    numbers.length === new Set(numbers).size,
    `the repair history repeats a review number: ${numbers.join(', ')}`,
  );
  assert(
    numbers.every((value, index) => value === index + 1),
    `the repair history is not 1..${String(numbers.length)} in order: ${numbers.join(', ')}`,
  );
  assert(
    numbers[numbers.length - 1] === repairNumber,
    `the current position names review ${String(repairNumber)}; the history runs to review ` +
      `${String(numbers[numbers.length - 1])}`,
  );

  // Every mutable result form, in every region that is not the canonical
  // section. `15/15 checks` slipped through a pattern that only knew about
  // gate names and sub-gate counts.
  const MUTABLE = [
    { why: 'an N/N ratio', re: /\b\d+\/\d+\b/ },
    { why: 'a test count', re: /\b\d+\s+tests?\b/ },
    { why: 'a task count', re: /\b\d+\s+tasks?\b/ },
    { why: 'a findings count', re: /\b\d+\s+findings?\b/ },
    { why: 'a check count', re: /\b\d+\s+checks?\b/ },
    { why: 'a sub-gate count', re: /\b\d+\s+sub-gates?\b/ },
    { why: 'a gate result', re: /GATE-(?:SEC|MIGR|INTEG|CONC|UNIT|E2E)[^\n|]*\d/ },
  ];
  const forbidden = [
    ['the Phase 03 ledger row', [ledgerRow]],
    ['the Phase 03 gate battery', battery.body.split('\n')],
  ];
  for (const [where, lines] of forbidden) {
    for (const line of lines) {
      const hit = MUTABLE.find((pattern) => pattern.re.test(line));
      assert(
        hit === undefined,
        `${where} restates ${String(hit?.why)}: ${line.trim().slice(0, 70)}`,
      );
    }
  }

  // A superseded repair section must not claim to be current.
  const stale = text
    .split('\n')
    .filter((line) => /holds the current counts|This section holds the current/i.test(line));
  assert(
    stale.length === 0,
    `a superseded section still claims to be current: ${stale[0]?.trim().slice(0, 70) ?? ''}`,
  );

  return (
    `one canonical section for review ${String(repairNumber)}; position, history, evidence ` +
    'label, ledger row and battery all agree and restate nothing'
  );
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
