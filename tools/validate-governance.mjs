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
function marked(text, name) {
  const open = `<!-- ${name}:begin -->`;
  const close = `<!-- ${name}:end -->`;
  const from = text.indexOf(open);
  const to = text.indexOf(close);
  if (from < 0 || to < 0 || to < from) return undefined;
  return text.slice(from + open.length, to);
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

  // The gate battery is bounded by explicit markers and must sit inside the
  // canonical section. Selecting "the first bash block starting with
  // node tools/validate-governance" found one inside the Phase 00 record.
  const battery = marked(text, 'phase-03-gate-battery');
  assert(battery !== undefined, 'the Phase 03 gate battery has no bounding markers');
  assert(
    evidence.includes('<!-- phase-03-gate-battery:begin -->'),
    'the Phase 03 gate battery is outside the canonical evidence section',
  );

  // The Phase 03 ledger row links to the canonical section and restates nothing.
  const ledgerRow = text.split('\n').find((line) => line.startsWith('| 03 |'));
  assert(ledgerRow !== undefined, 'the phase ledger has no Phase 03 row');
  assert(ledgerRow.includes(ANCHOR), `the Phase 03 ledger row does not link to ${ANCHOR}`);

  // The current-position table must name the current review, not an older one.
  const position = section(text, '## Current position');
  assert(position !== undefined, 'there is no "## Current position" section');
  // The cardinal and the ordinal must describe the same review: "nine reviews
  // completed; the ninth repair" is the shape, and it went stale as a pair.
  const ORDINALS = {
    seven: 'seventh',
    eight: 'eighth',
    nine: 'ninth',
    ten: 'tenth',
    eleven: 'eleventh',
    twelve: 'twelfth',
  };
  const reviews = /([a-z]+) customer reviews completed/.exec(position)?.[1];
  const repair = /the ([a-z]+) repair is implemented/.exec(position)?.[1];
  assert(
    reviews !== undefined && repair !== undefined && ORDINALS[reviews] === repair,
    `current position says "${String(reviews)}" reviews and "${String(repair)}" repair`,
  );

  // And the newest repair section must be the one the position names.
  const sections = [...text.matchAll(/^### ([A-Za-z]+) security repair \(customer review \d+\)/gm)];
  const newest = sections[sections.length - 1]?.[1]?.toLowerCase();
  assert(
    newest === repair,
    `current position names the ${String(repair)} repair; the last section is the ${String(newest)}`,
  );

  // The canonical evidence must say which repair tree it was measured on, and
  // that ordinal is compared against the two derived above rather than against a
  // fixed value. The label read "the tenth-repair tree" while the position and
  // the newest section both said eleventh, and nothing looked: the counts under
  // it were then attributed to a tree they were not measured on.
  const measured = /Measured on the ([a-z]+)-repair tree/.exec(evidence)?.[1];
  assert(
    measured !== undefined,
    'the canonical evidence does not say which repair tree it was measured on',
  );
  assert(
    measured === repair,
    `the canonical evidence was "measured on the ${String(measured)}-repair tree"; the current ` +
      `position and the newest repair section both name the ${String(repair)} repair`,
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
    ['the Phase 03 gate battery', battery.split('\n')],
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
    `one canonical section, measured on the ${repair}-repair tree; ledger row, battery and ` +
    'current position agree and restate nothing'
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
