// The governance checks themselves, over documents named by the caller.
//
// The CLI used to accept PRSYSTEM_RUNBOOK, PRSYSTEM_PHASE_STATUS and
// PRSYSTEM_EVIDENCE_MANIFEST so the negative-fixture harness could point two
// checks at mutated copies. That made the production gate redirectable: with the
// three set to clean decoys, the canonical `phase-status.md` could be changed to
// `DONE` and the gate still reported 15 of 15.
//
// The seam is now a function parameter. The CLI passes the repository's own
// paths and reads no configuration at all; the fixture harness calls this
// function directly with temporary files.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import {
  BATTERY_ENTRY_KEYS,
  GOVERNED_STATE,
  MANIFEST_KEYS,
  REQUIRED_BATTERY,
} from './phase-03-battery.mjs';
import { SUB_GATES } from './gate-sec-config.mjs';

/**
 * Refuses a JSON document that names one member twice in the same object.
 *
 * A character scan, because the defect is invisible after parsing: `JSON.parse`
 * keeps the last of two members with the same name and reports nothing.
 */
function assertNoDuplicateJsonKeys(text) {
  const stack = [];
  let index = 0;
  let expectKey = false;
  while (index < text.length) {
    const ch = text[index];
    if (ch === '"') {
      let end = index + 1;
      let value = '';
      while (end < text.length && text[end] !== '"') {
        if (text[end] === '\\') {
          value += text[end + 1];
          end += 2;
          continue;
        }
        value += text[end];
        end += 1;
      }
      if (expectKey && stack.length > 0) {
        const seen = stack[stack.length - 1];
        if (seen.has(value)) {
          throw new Error(`the JSON document names "${value}" twice in the same object`);
        }
        seen.add(value);
        expectKey = false;
      }
      index = end + 1;
      continue;
    }
    if (ch === '{') {
      stack.push(new Set());
      expectKey = true;
    } else if (ch === '}') {
      stack.pop();
      expectKey = false;
    } else if (ch === ',') {
      expectKey = stack.length > 0;
    } else if (ch === ':' || ch === '[') {
      expectKey = false;
    }
    index += 1;
  }
}

/**
 * Runs every governance check against the three named documents.
 *
 * @param {{ root: string, runbookPath: string, phaseStatusPath: string,
 *           manifestPath: string }} paths
 * @returns {{ results: { id: string, title: string, ok: boolean, detail: string }[],
 *             failed: number }}
 */
export function runGovernanceChecks({ root, runbookPath, phaseStatusPath, manifestPath }) {
  const ROOT = root;
  const RUNBOOK_PATH = runbookPath;
  const PHASE_STATUS_PATH = phaseStatusPath;
  const EVIDENCE_MANIFEST_PATH = manifestPath;
  const DOCS = join(ROOT, 'docs');
  const IMPL = join(DOCS, 'implementation');

  const PHASE_MIN = 1;
  const PHASE_MAX = 23;
  const EXPECTED_DEC_COUNT = 279;
  const EXPECTED_SOURCE_DOCS = 27;

  const read = (p) => readFileSync(p, 'utf8');
  const buildPlan = read(join(IMPL, 'build-plan.md'));
  // The supplied path, not the canonical one.
  //
  // Only check 15 read `phaseStatusPath`; checks 1 to 13 opened
  // `docs/implementation/phase-status.md` regardless, so a scratch document with
  // a phase deleted from its ledger still returned 15 of 15 and the fixture
  // harness was validating the real file while believing it validated a copy.
  const phaseStatus = read(phaseStatusPath);
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
    // The state cell may carry more than the token; check 15 is where it must be
    // exact. Here the row only has to be recognisable as a phase row, or a stray
    // addition would hide the phase from the enumeration instead of being
    // reported as the extra claim it is.
    ...phaseStatus.matchAll(/^\|\s*(\d{2})\s*\|\s*[^|]+\|\s*\*{0,2}`[A-Z_ ]+`[^|]*\|/gm),
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
    assert(
      multi.length === 0,
      `assigned to multiple phases: ${multi.map(([id]) => id).join(', ')}`,
    );
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
      assert(
        adrUnlisted.length === 0,
        `ADRs not listed in the ADR index: ${adrUnlisted.join(', ')}`,
      );
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
        const closer = adrFiles.find((f) =>
          read(join(ARCH, 'adr', f)).includes(`**Closes:** ${id}`),
        );
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
        for (const m of text.matchAll(
          /(\d+)\s+(?:pending\s+)?P1(?:\s+configuration)?\s+items?/gi,
        )) {
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
    const listed = [
      ...new Set([...catalogue.matchAll(/`(SEC-[A-Z-]+)`/g)].map((m) => m[1])),
    ].sort();

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
  check('15', 'Phase 03 evidence matches the machine-readable manifest', () => {
    // Rendered structure, not lines.
    //
    // Every previous version of this check read `phase-status.md` with regular
    // expressions over lines, and every round found another construct the patterns
    // did not model: a row without pipes, a Setext heading, a raw `<h3>`, a tab
    // after the `#`, a correct label inside an HTML comment. Those are not gaps in
    // the patterns; they are the difference between text that looks like Markdown
    // and Markdown as it renders. The document is parsed with a pinned CommonMark
    // and GFM parser and this check reads the tree.
    //
    // What the document must say is declared separately, in
    // `phase-03-evidence.json`. The tree has to match that manifest exactly, so a
    // number is written down once and the prose is checked against it rather than
    // parsed for meaning.
    const text = readFileSync(PHASE_STATUS_PATH, 'utf8');
    const manifestText = readFileSync(EVIDENCE_MANIFEST_PATH, 'utf8');
    // `JSON.parse` keeps the last of two members with the same name, silently.
    // A manifest carrying `"phaseState": "DONE"` above the governed value parses
    // to the governed value and reads as the other one.
    assertNoDuplicateJsonKeys(manifestText);
    const manifest = JSON.parse(manifestText);
    const ANCHOR = '#current-phase-03-evidence';

    // Top-level tokens with their exact character bounds. marked's `raw` values
    // concatenate to the source, so accumulating them gives every token a span,
    // which is what the bounded regions are expressed in.
    const tokens = [];
    let offset = 0;
    for (const token of marked.lexer(text)) {
      tokens.push({ ...token, start: offset, end: offset + token.raw.length });
      offset += token.raw.length;
    }
    assert(offset === text.length, 'the parsed document does not reconstruct the source exactly');

    /**
     * Every rendered token, with the top-level token whose span contains it.
     *
     * Only the top level was inspected, so a table, a heading or raw HTML written
     * inside a blockquote rendered normally and was never looked at. A container
     * is not a hiding place.
     */
    const allTokens = [];
    const walk = (token, top) => {
      allTokens.push({ token, top });
      // `header` is a table's cells but a boolean on a list item, so every branch
      // is guarded by shape rather than by name.
      for (const key of ['tokens', 'items', 'header']) {
        if (!Array.isArray(token[key])) continue;
        for (const child of token[key]) walk(child, top);
      }
      if (!Array.isArray(token.rows)) return;
      for (const row of token.rows) for (const cell of row) walk(cell, top);
    };
    for (const token of tokens) walk(token, token);

    const NAMED_ENTITIES = {
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
      nbsp: ' ',
    };

    /** Entity references resolved, because a reader sees the character. */
    const decodeEntities = (value) =>
      value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
        if (body.startsWith('#x') || body.startsWith('#X')) {
          return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
        }
        if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
        return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
      });

    /**
     * The text a reader actually sees.
     *
     * A link's destination and title, a reference definition, code, comments and
     * raw HTML are not visible text: a correct measured-on label written in a link
     * title, and a stale one written in the prose beside it, are one label and one
     * decoy — the other way round from how the raw source reads.
     */
    const visibleText = (token) => {
      if (token === undefined || token === null) return '';
      if (token.type === 'html' || token.type === 'code' || token.type === 'codespan') return '';
      if (token.type === 'def' || token.type === 'image') return '';
      const children = [];
      for (const key of ['tokens', 'items', 'header']) {
        if (Array.isArray(token[key])) children.push(...token[key]);
      }
      if (Array.isArray(token.rows)) for (const row of token.rows) children.push(...row);
      if (children.length > 0) return children.map(visibleText).join('\n');
      if (token.type === 'text' || token.type === 'escape' || token.type === undefined) {
        return decodeEntities(String(token.text ?? ''));
      }
      if (token.type === 'space') return '\n';
      return decodeEntities(String(token.text ?? ''));
    };

    const APPROVED_HTML = new Set([
      '<!-- phase-03-gate-battery:begin -->',
      '<!-- phase-03-gate-battery:end -->',
      '<!-- phase-03-evidence:begin -->',
      '<!-- phase-03-evidence:end -->',
      '<!-- phase-03-repair-history:begin -->',
      '<!-- phase-03-repair-history:end -->',
    ]);

    const inSpan = (token, span) => token.start >= span.start && token.end <= span.end;
    /** A nested token is inside a span when the top-level token containing it is. */
    const nestedInSpan = (entry, span) => inSpan(entry.top, span);

    /** Every rendered heading, at any level, in any container, in any form. */
    const renderedHeadings = [];
    for (const entry of allTokens) {
      if (entry.token.type === 'heading') {
        renderedHeadings.push({
          entry,
          depth: entry.token.depth,
          text: visibleText(entry.token).trim(),
          raw: entry.token.raw.replace(/\n+$/, ''),
          html: false,
        });
        continue;
      }
      if (entry.token.type !== 'html') continue;
      for (const match of entry.token.raw.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
        renderedHeadings.push({
          entry,
          depth: Number(match[1]),
          text: decodeEntities(match[2]).trim(),
          raw: match[0],
          html: true,
        });
      }
    }

    /**
     * Every row of a table, as written, must have the column count it declares.
     *
     * GFM truncates a row with too many cells and pads one with too few, so the
     * parsed rows are always the header's width and a malformed row reads as
     * well-formed. The written shape is the only place the mistake is visible.
     */
    const assertRowShapes = (table, what) => {
      const width = table.header.length;
      const lines = table.raw.split('\n').filter((line) => line.trim() !== '');
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
        const cells = inner.split(/(?<!\\)\|/).length;
        assert(
          cells === width,
          `a ${what} row has ${String(cells)} cells; the table declares ${String(width)}: ` +
            `${trimmed.slice(0, 70)}`,
        );
        // The delimiter row is row 1 and is shaped like any other.
        void index;
      });
    };

    // ------------------------------------------------------------ the regions
    /**
     * A bounded region, delimited by two top-level HTML comment tokens.
     *
     * Found by parsing, not by `indexOf`: the marker text written anywhere else —
     * in a fenced code block, in a table cell — is not a boundary and must not be
     * mistaken for one, so it is refused outright and the markers keep exactly one
     * home each.
     */
    const boundedRegion = (name) => {
      const open = `<!-- ${name}:begin -->`;
      const close = `<!-- ${name}:end -->`;
      for (const [marker, label] of [
        [open, 'begin'],
        [close, 'end'],
      ]) {
        const occurrences = text.split(marker).length - 1;
        assert(
          occurrences === 1,
          `${name}: the ${label} marker text occurs ${String(occurrences)} times in the document; ` +
            'it must occur exactly once, as its own boundary',
        );
      }
      const comments = tokens.filter((token) => token.type === 'html');
      const beginToken = comments.filter((token) => token.raw.trim() === open);
      const endToken = comments.filter((token) => token.raw.trim() === close);
      assert(
        beginToken.length === 1 && endToken.length === 1,
        `${name}: expected exactly one top-level begin marker and one end marker, found ` +
          `${String(beginToken.length)} and ${String(endToken.length)}`,
      );
      assert(
        endToken[0].start > beginToken[0].start,
        `${name}: the end marker precedes the begin marker`,
      );
      return {
        start: beginToken[0].start,
        end: endToken[0].end,
        body: text.slice(beginToken[0].end, endToken[0].start),
      };
    };

    const battery = boundedRegion('phase-03-gate-battery');
    const measured = boundedRegion('phase-03-evidence');
    const history = boundedRegion('phase-03-repair-history');

    const evidenceHeadings = renderedHeadings.filter(
      (heading) => heading.depth === 2 && heading.text === 'Current Phase 03 evidence',
    );
    assert(
      evidenceHeadings.length === 1,
      `there are ${String(evidenceHeadings.length)} visible "Current Phase 03 evidence" H2 ` +
        'headings; there must be exactly one',
    );
    // The heading itself, not whatever contains it. Deriving the section span
    // from a descendant's top-level container made a blockquoted H2 govern the
    // blockquote rather than the section, and every containment test then
    // answered about the wrong span.
    assert(
      evidenceHeadings[0].entry.top === evidenceHeadings[0].entry.token,
      'the "Current Phase 03 evidence" H2 is nested inside another block',
    );
    const evidenceHeading = evidenceHeadings[0].entry.token;
    const nextTop = tokens.find(
      (token) =>
        token.start > evidenceHeading.start && token.type === 'heading' && token.depth <= 2,
    );
    const evidenceSpan = {
      start: evidenceHeading.start,
      end: nextTop === undefined ? text.length : nextTop.start,
    };
    for (const [region, what] of [
      [battery, 'the Phase 03 gate battery'],
      [measured, 'the canonical evidence results'],
    ]) {
      assert(
        region.start >= evidenceSpan.start && region.end <= evidenceSpan.end,
        `${what} is not inside the canonical evidence section`,
      );
    }

    // Raw HTML inside a governed region is refused unless it is one of the six
    // approved boundary markers. An HTML comment renders as nothing, so anything
    // written inside one is invisible to a reader and would otherwise be free to
    // carry a label, a heading or a table row that only a parser sees.
    const positionHeadings = renderedHeadings.filter(
      (heading) => heading.depth === 2 && heading.text === 'Current position',
    );
    assert(
      positionHeadings.length === 1,
      `there are ${String(positionHeadings.length)} visible "Current position" H2 headings; there ` +
        'must be exactly one',
    );
    assert(
      positionHeadings[0].entry.top === positionHeadings[0].entry.token,
      'the "Current position" H2 is nested inside another block',
    );
    const positionHeading = positionHeadings[0].entry.token;
    const afterPosition = tokens.find(
      (token) =>
        token.start > positionHeading.start && token.type === 'heading' && token.depth <= 2,
    );
    const positionSpan = {
      start: positionHeading.start,
      end: afterPosition === undefined ? text.length : afterPosition.start,
    };

    // The phase ledger's own span, so raw HTML inside it is governed too.
    // Exactly one ledger table, and exactly one Phase 03 and one Phase 04 row in
    // the whole document. A second, blockquoted ledger declaring Phase 03 `DONE`
    // rendered beside the real one and was never counted.
    const ledgerTables_ = allTokens.filter(
      (entry) =>
        entry.token.type === 'table' &&
        (entry.token.rows ?? []).some((row) => ['03', '04'].includes(row[0]?.text.trim())),
    );
    assert(
      ledgerTables_.length === 1,
      `there are ${String(ledgerTables_.length)} rendered phase ledger tables; there must be ` +
        'exactly one',
    );
    const ledgerTable = ledgerTables_[0];
    for (const phase of ['03', '04']) {
      const rows = allTokens
        .filter((entry) => entry.token.type === 'table')
        .flatMap((entry) => entry.token.rows ?? [])
        .filter((row) => row[0]?.text.trim() === phase);
      assert(
        rows.length === 1,
        `there are ${String(rows.length)} Phase ${phase} rows in the document; there must be ` +
          'exactly one',
      );
    }

    // Raw HTML, governed.
    //
    // Applied to the evidence section, the current position, the phase ledger and
    // the repair history, and to nested tokens as well as top-level ones. An HTML
    // comment renders as nothing, so anything written inside one is invisible to a
    // reader and must be invisible to this check too.
    // Everywhere in the document, not only inside the governed regions.
    //
    // Implementing HTML semantics with heading regexes is a losing game —
    // `<h3 >…</h3 >` and `re<span></span>pair` both render as headings and
    // neither matches a pattern written for `<h3>…</h3>`. The document has no
    // need for raw HTML at all beyond its six boundary comments, so everything
    // else is refused and there is nothing left to parse.
    for (const entry of allTokens) {
      if (entry.token.type !== 'html') continue;
      assert(
        APPROVED_HTML.has(entry.token.raw.trim()),
        'raw HTML is not an approved boundary marker: ' + `${entry.token.raw.trim().slice(0, 70)}`,
      );
    }

    // ------------------------------------------------------- the gate battery
    const batteryCode = tokens.filter(
      (token) => token.type === 'code' && inSpan(token, battery) && token.lang === 'bash',
    );
    assert(
      batteryCode.length === 1,
      `the Phase 03 gate battery holds ${String(batteryCode.length)} bash blocks; there must be one`,
    );
    const batteryCommands = batteryCode[0].text
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter((line) => line !== '');
    // ------------------------------------------------- the required battery
    //
    // Declared in `phase-03-battery.mjs`, not here and not in the manifest. The
    // manifest, the battery block and the evidence table could be edited together,
    // so removing `pnpm run test:security` from all three — or reducing the
    // battery to `git diff --check` — left this check reporting 15 of 15. A gate
    // the document can delete is not a gate. The manifest records what was
    // measured; what must be measured is not its to decide.
    const required = REQUIRED_BATTERY.map((entry) => entry.command);
    assert(
      new Set(required).size === required.length,
      'the required battery lists a command twice',
    );

    const declared = manifest.battery.map((entry) => entry.command);
    assert(
      new Set(declared).size === declared.length,
      `the evidence manifest lists a command twice: ${declared.join('; ')}`,
    );
    const missing = required.filter((command) => !declared.includes(command));
    const extra = declared.filter((command) => !required.includes(command));
    assert(
      missing.length === 0,
      `the evidence manifest omits required battery commands: ${missing.join('; ')}`,
    );
    assert(
      extra.length === 0,
      `the evidence manifest declares commands the required battery does not: ${extra.join('; ')}`,
    );

    assert(
      new Set(batteryCommands).size === batteryCommands.length,
      `the Phase 03 gate battery lists a command twice: ${batteryCommands.join('; ')}`,
    );
    const blockMissing = required.filter((command) => !batteryCommands.includes(command));
    const blockExtra = batteryCommands.filter((command) => !required.includes(command));
    assert(
      blockMissing.length === 0,
      `the Phase 03 gate battery omits required commands: ${blockMissing.join('; ')}`,
    );
    assert(
      blockExtra.length === 0,
      `the Phase 03 gate battery lists commands the requirement does not: ${blockExtra.join('; ')}`,
    );
    assert(
      declared.join('\n') === required.join('\n'),
      'the evidence manifest lists the required commands in a different order',
    );
    assert(
      batteryCommands.join('\n') === required.join('\n'),
      'the Phase 03 gate battery lists the required commands in a different order',
    );

    for (const wanted of REQUIRED_BATTERY) {
      const entry = manifest.battery.find((candidate) => candidate.command === wanted.command);
      assert(
        entry.executions === wanted.runs,
        `${wanted.command} must be executed ${String(wanted.runs)} time(s); the manifest records ` +
          `${String(entry.executions)}`,
      );
    }

    // ------------------------------------------------ the manifest's own shape
    const manifestKeys = Object.keys(manifest).sort();
    assert(
      manifestKeys.join(',') === [...MANIFEST_KEYS].sort().join(','),
      `the evidence manifest declares keys [${manifestKeys.join(', ')}]; it must declare exactly ` +
        `[${[...MANIFEST_KEYS].sort().join(', ')}]`,
    );
    for (const entry of manifest.battery) {
      const keys = Object.keys(entry).sort();
      assert(
        keys.join(',') === [...BATTERY_ENTRY_KEYS].sort().join(','),
        `a battery entry declares keys [${keys.join(', ')}]; it must declare exactly ` +
          `[${[...BATTERY_ENTRY_KEYS].sort().join(', ')}]`,
      );
      assert(
        typeof entry.command === 'string' && entry.command !== '',
        'a battery entry has no command',
      );
      assert(
        typeof entry.result === 'string' && entry.result !== '',
        `${entry.command} has no result`,
      );
    }

    // -------------------------------------------------- the governed state
    //
    // Phase 03 is not accepted, and this document may not say otherwise. An
    // accepted transition is a customer decision, so it is a change to
    // `phase-03-battery.mjs` and not something the manifest can declare about
    // itself.
    for (const key of ['currentPhase', 'phaseState', 'customerAcceptance']) {
      assert(
        manifest[key] === GOVERNED_STATE[key],
        `the evidence manifest declares ${key} = ${JSON.stringify(manifest[key])}; the governed ` +
          `state is ${JSON.stringify(GOVERNED_STATE[key])}`,
      );
    }

    // One review number, stated four times, and the fourth is governed outside
    // the document. Every mutable pointer agreed only with the others, so
    // rolling all of them back — or deleting the newest record and rolling every
    // pointer back with it — left nothing to disagree with.
    for (const key of ['customerReviewNumber', 'latestRepairNumber', 'measuredOnRepairNumber']) {
      assert(
        manifest[key] === GOVERNED_STATE.governedReviewNumber,
        `the evidence manifest declares ${key} = ${JSON.stringify(manifest[key])}; the governed ` +
          `review number is ${String(GOVERNED_STATE.governedReviewNumber)}`,
      );
    }

    // -------------------------------------------------------- the exit codes
    //
    // Success is decided here, by the recorded exit codes, and never by the free
    // text beside them. "PASS" next to "exit 1" was accepted because the Result
    // cell was prose nobody parsed and nobody had to.
    for (const entry of manifest.battery) {
      assert(
        Number.isInteger(entry.executions) && entry.executions >= 1,
        `${entry.command} declares an execution count that is not a positive integer`,
      );
      assert(
        Array.isArray(entry.exits) && entry.exits.length === entry.executions,
        `${entry.command} declares ${String(entry.executions)} executions and ` +
          `${String(entry.exits?.length)} exit codes`,
      );
      assert(
        entry.exits.every((code) => code === 0),
        `${entry.command} records a non-zero exit code: ${JSON.stringify(entry.exits)}`,
      );
      // And the prose beside the exit codes may not contradict them. Success is
      // the exit code; a result that says the command failed is either wrong
      // about the exit code or wrong about itself, and either way it is refused.
      assert(
        !/\b(fail|failed|failing|skip|skipped|not run|non-?zero|error)\b/i.test(entry.result),
        `${entry.command} exited zero but its recorded result claims otherwise: ${entry.result}`,
      );
    }

    // ----------------------------------------------------- the evidence table
    const evidenceTables = allTokens
      .filter((entry) => entry.token.type === 'table' && nestedInSpan(entry, measured))
      .map((entry) => entry.token);
    assert(
      evidenceTables.length === 1,
      `the canonical evidence results hold ${String(evidenceTables.length)} tables; there must be ` +
        'exactly one',
    );
    const table = evidenceTables[0];
    assertRowShapes(table, 'canonical evidence');
    const header = table.header.map((cell) => cell.text.trim());
    assert(
      header.join(' | ') === 'Command | Status | Result',
      `the canonical evidence table header is "${header.join(' | ')}"; it must be ` +
        '"Command | Status | Result"',
    );

    const byCommand = new Map();
    for (const row of table.rows) {
      assert(
        row.length === 3,
        `a result row does not have exactly three cells: ${row.map((c) => c.text).join(' | ')}`,
      );
      const [commandCell, statusCell, resultCell] = row.map((cell) => cell.text.trim());
      const quoted = [...commandCell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      assert(
        quoted.length === 1,
        `a result row names ${String(quoted.length)} backticked commands: ${commandCell}`,
      );
      const command = quoted[0];
      assert(
        commandCell === `\`${command}\``,
        `a result row's command cell carries more than the command: ${commandCell}`,
      );
      const entry = manifest.battery.find((candidate) => candidate.command === command);
      assert(
        entry !== undefined,
        `the canonical evidence results report a command the manifest does not declare: ${command}`,
      );
      assert(
        !byCommand.has(command),
        `the canonical evidence results carry two rows for ${command}`,
      );
      assert(
        statusCell === 'PASS',
        `the canonical evidence records a status other than PASS: ${command} → ${statusCell}`,
      );
      assert(
        resultCell === entry.result,
        `the canonical evidence result for ${command} is "${resultCell}"; the manifest declares ` +
          `"${entry.result}"`,
      );
      byCommand.set(command, resultCell);
    }
    const unreported = declared.filter((command) => !byCommand.has(command));
    assert(
      unreported.length === 0,
      `the canonical evidence results have no row for: ${unreported.join('; ')}`,
    );

    // ------------------------------------------------- the measured-on label
    //
    // Visible text only: a correct label written inside an HTML comment renders as
    // nothing, and a stale one beside it was what a reader saw.
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
    const visible = tokens
      .filter((token) => inSpan(token, measured))
      .map((token) => visibleText(token))
      .join('\n');
    const labels = [...visible.matchAll(/Measured on the ([a-z]+)-repair tree/g)];
    assert(
      labels.length === 1,
      `the canonical evidence results carry ${String(labels.length)} visible measured-on labels; ` +
        'there must be exactly one',
    );
    const labelNumber = ORDINALS.indexOf(labels[0][1]) + 1;
    assert(
      labelNumber === manifest.measuredOnRepairNumber,
      `the canonical evidence was measured on the ${labels[0][1]}-repair tree ` +
        `(${String(labelNumber)}); the manifest declares ${String(manifest.measuredOnRepairNumber)}`,
    );

    // --------------------------------------------------- the current position
    const positionTables = allTokens
      .filter((entry) => entry.token.type === 'table' && nestedInSpan(entry, positionSpan))
      .map((entry) => entry.token);
    assert(
      positionTables.length === 1,
      `the current position holds ${String(positionTables.length)} tables; there must be exactly one`,
    );

    assertRowShapes(positionTables[0], 'current-position');
    const positionRows = new Map();
    for (const row of positionTables[0].rows) {
      assert(
        row.length === 2,
        `a current-position row does not have exactly two cells: ${row.map((c) => c.text).join(' | ')}`,
      );
      const key = row[0].text.trim();
      assert(!positionRows.has(key), `the current position states "${key}" twice`);
      positionRows.set(key, row[1].text.trim());
    }

    const EXPECTED_POSITION = new Map([
      ['Current phase', manifest.currentPhase],
      ['Phase state', `\`${manifest.phaseState}\``],
      ['Customer review number', String(manifest.customerReviewNumber)],
      ['Latest implemented repair number', String(manifest.latestRepairNumber)],
      ['Customer acceptance', `\`${manifest.customerAcceptance}\``],
    ]);
    for (const [key, want] of EXPECTED_POSITION) {
      assert(positionRows.has(key), `the current position has no "${key}" row`);
      assert(
        positionRows.get(key) === want,
        `the current position states ${key} = "${String(positionRows.get(key))}"; the manifest ` +
          `declares "${want}"`,
      );
    }
    assert(
      positionRows.get('Next phase') === GOVERNED_STATE.nextPhase,
      'the current position states Next phase = ' +
        `${JSON.stringify(positionRows.get('Next phase'))}; the governed state is ` +
        `${JSON.stringify(GOVERNED_STATE.nextPhase)}`,
    );
    // Exactly one state token in the cell, and it is the governed one. The row
    // could say `IN PROGRESS` while the ledger still said NOT STARTED.
    const nextStateCell = positionRows.get('Next phase state') ?? '';
    const nextStateTokens = [...nextStateCell.matchAll(/`([A-Z_ ]+)`/g)].map((m) => m[1]);
    assert(
      nextStateTokens.length === 1 && nextStateTokens[0] === GOVERNED_STATE.nextPhaseState,
      `the current position states Next phase state = ${JSON.stringify(nextStateCell)}; it must ` +
        `name exactly one state and it must be ${GOVERNED_STATE.nextPhaseState}`,
    );

    const NARRATIVE_ROWS = new Set(['Next phase', 'Next phase state', 'Blocking conflicts']);
    for (const key of positionRows.keys()) {
      assert(
        EXPECTED_POSITION.has(key) || NARRATIVE_ROWS.has(key),
        `the current position carries a row the manifest does not govern: ${key}`,
      );
    }
    assert(
      manifest.customerAcceptance === 'NOT_ACCEPTED',
      `the manifest declares customer acceptance ${manifest.customerAcceptance}; Phase 03 is not ` +
        'accepted and this document does not claim otherwise',
    );
    assert(
      manifest.customerReviewNumber === manifest.latestRepairNumber,
      `the manifest declares review ${String(manifest.customerReviewNumber)} and repair ` +
        `${String(manifest.latestRepairNumber)}`,
    );

    // -------------------------------------------------------- the phase ledger
    const ledgerTables = [ledgerTable.token];
    const ledgerRows = ledgerTables[0].rows.filter((row) => row[0].text.trim() === '03');
    assert(
      ledgerRows.length === 1,
      `the phase ledger holds ${String(ledgerRows.length)} Phase 03 rows; there must be exactly one`,
    );
    const ledgerRow = ledgerRows[0];
    assertRowShapes(ledgerTables[0], 'phase ledger');
    const ledgerText = ledgerRow.map((cell) => cell.text).join(' | ');
    // The state cell, exactly. A `**DONE**` appended beside the required token
    // left the token in place and the row saying two things.
    const STATE_COLUMN = ledgerTables[0].header.findIndex((cell) => cell.text.trim() === 'State');
    assert(STATE_COLUMN >= 0, 'the phase ledger has no State column');
    const phase03State = ledgerRow[STATE_COLUMN].text.trim();
    assert(
      phase03State === `\`${manifest.phaseState}\``,
      `the Phase 03 ledger state cell renders ${JSON.stringify(phase03State)}; it must render ` +
        `exactly \`${manifest.phaseState}\``,
    );
    const stateTokens = [...ledgerText.matchAll(/`([A-Z_ ]+)`/g)].map((m) => m[1]);
    assert(
      stateTokens.length === 1,
      `the Phase 03 ledger row names ${String(stateTokens.length)} state tokens; there must be ` +
        'exactly one',
    );
    // The link's own destination, not the anchor appearing somewhere in the cell.
    // A link to elsewhere carrying the correct anchor in its *title* read as
    // correct while pointing at nothing.
    const ledgerLinks = [];
    for (const cell of ledgerRow) {
      walk(cell, ledgerTables[0]);
      const collect = (token) => {
        if (token.type === 'link') ledgerLinks.push(token);
        for (const child of token.tokens ?? []) collect(child);
      };
      collect(cell);
    }
    const anchorLinks = ledgerLinks.filter((link) => link.href === ANCHOR);
    assert(
      anchorLinks.length === 1,
      `the Phase 03 ledger row has ${String(anchorLinks.length)} links whose destination is ` +
        `${ANCHOR}; there must be exactly one`,
    );
    // Phase 04 has not started, and the ledger is where that is recorded.
    const nextRows = ledgerTables[0].rows.filter((row) => row[0].text.trim() === '04');
    assert(
      nextRows.length === 1,
      `the phase ledger holds ${String(nextRows.length)} Phase 04 rows; there must be exactly one`,
    );
    const phase04State = nextRows[0][STATE_COLUMN].text.trim();
    assert(
      phase04State === `\`${GOVERNED_STATE.nextPhaseState}\``,
      `the Phase 04 ledger state cell renders ${JSON.stringify(phase04State)}; it must render ` +
        `exactly \`${GOVERNED_STATE.nextPhaseState}\``,
    );

    const ledgerOrdinal = new RegExp(`\\b(${ORDINALS.join('|')})\\b`, 'i').exec(ledgerText);
    assert(
      ledgerOrdinal === null,
      `the Phase 03 ledger row restates the repair ordinal "${String(ledgerOrdinal?.[1])}"; the ` +
        'manifest is the one place that number is written',
    );

    // ------------------------------------------------------- the repair history
    //
    // Every heading the document renders, at every level and in every form: ATX,
    // Setext, and raw `<h1>`–`<h6>`. A heading that describes a repair or a
    // customer review must be the canonical, unindented H3 record, inside the
    // bounded history. A canonical heading written inside an HTML comment renders
    // as nothing and cannot stand in for a record.
    const CANONICAL =
      /^### ([A-Za-z]+) security repair \(customer review (\d+)\) — `SECURITY_REPAIR_REQUIRED`$/;
    const DECLARED_SECTION_HEADINGS = new Set(['Remaining blockers', 'GATE-SEC sub-gate counts']);
    const DESCRIBES_A_REPAIR = /\brepair\b|\bcustomer review\b/i;

    const sections = [];
    for (const entry of renderedHeadings) {
      const canonical = !entry.html && CANONICAL.test(entry.raw);
      if (canonical) {
        assert(
          nestedInSpan(entry.entry, history),
          `a repair heading sits outside the bounded repair history: ${entry.raw}`,
        );
        assert(
          entry.entry.top === entry.entry.token,
          `a repair heading is nested inside another block: ${entry.raw}`,
        );
        const parsed = CANONICAL.exec(entry.raw);
        sections.push({ raw: entry.raw, word: parsed[1].toLowerCase(), number: Number(parsed[2]) });
        continue;
      }
      assert(
        !DESCRIBES_A_REPAIR.test(entry.text),
        `a heading describes a repair or a customer review but is not a canonical, unindented ` +
          `H3 repair heading: ${entry.raw.slice(0, 80)}`,
      );
      if (!nestedInSpan(entry.entry, history)) continue;
      if (entry.html || entry.depth !== 3) continue;
      assert(
        DECLARED_SECTION_HEADINGS.has(entry.text),
        `a heading in the repair history is neither a canonical repair heading nor a declared ` +
          `section heading: ${entry.raw.slice(0, 80)}`,
      );
    }

    const numbers = sections.map((entry) => entry.number);
    assert(numbers.length > 0, 'there are no numbered repair sections');
    for (const entry of sections) {
      assert(
        ORDINALS.indexOf(entry.word) + 1 === entry.number,
        `a repair heading disagrees with its own number: ${entry.raw}`,
      );
      // Every record states the governed state. A heading that claimed a
      // different one would be a record of a phase this document is not in.
      assert(
        entry.raw.endsWith(`\`${GOVERNED_STATE.phaseState}\``),
        `a repair heading states a state other than ${GOVERNED_STATE.phaseState}: ${entry.raw}`,
      );
    }

    // Unique, ordered and exactly contiguous 1..latestRepairNumber, in both the
    // manifest and the rendered history. Removing one repair from both, or
    // duplicating a number in both, left the two agreeing with each other and
    // wrong.
    assert(
      new Set(numbers).size === numbers.length,
      `the repair history repeats a review number: ${numbers.join(', ')}`,
    );
    const contiguous = Array.from({ length: GOVERNED_STATE.governedReviewNumber }, (_, i) => i + 1);
    assert(
      JSON.stringify(numbers) === JSON.stringify(contiguous),
      `the repair history is ${JSON.stringify(numbers)}; it must be 1..` +
        `${String(manifest.latestRepairNumber)} exactly`,
    );
    assert(
      JSON.stringify(manifest.repairHistory) === JSON.stringify(contiguous),
      `the manifest repair history is ${JSON.stringify(manifest.repairHistory)}; it must be 1..` +
        `${String(manifest.latestRepairNumber)} exactly`,
    );
    assert(
      JSON.stringify(numbers) === JSON.stringify(manifest.repairHistory),
      `the repair history is ${JSON.stringify(numbers)}; the manifest declares ` +
        `${JSON.stringify(manifest.repairHistory)}`,
    );
    assert(
      numbers[numbers.length - 1] === manifest.latestRepairNumber,
      `the manifest declares repair ${String(manifest.latestRepairNumber)}; the history runs to ` +
        `review ${String(numbers[numbers.length - 1])}`,
    );

    // Every mutable result form, in every region that is not the canonical
    // section.
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
      ['the Phase 03 ledger row', [ledgerText]],
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

    const stale = text
      .split('\n')
      .filter((line) => /holds the current counts|This section holds the current/i.test(line));
    assert(
      stale.length === 0,
      `a superseded section still claims to be current: ${stale[0]?.trim().slice(0, 70) ?? ''}`,
    );

    return (
      `manifest review ${String(manifest.customerReviewNumber)}; ` +
      `${String(declared.length)} battery commands, all exits zero; position, ledger, evidence ` +
      'table, label and repair history all match it'
    );
  });

  return { results, failed: results.filter((entry) => !entry.ok).length };
}
