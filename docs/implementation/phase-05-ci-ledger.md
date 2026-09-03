# PRsystem — Phase 05 CI ledger

**Artifact type:** evidence record, written at the Phase 05 closeout.
**Tested commit:** `35314ba210f609269863f0b528bbe827e6a5d3ce` — the accepted Phase 05 tree.
**Workflow:** [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), five jobs,
**41 `run` steps**.
**Executed:** 2026-09-03, locally, on macOS 25.3.0 with Node v22.17.0, pnpm 9.15.9 and
Docker 29.6.1. The workflow pins Node 22.17.0 and pnpm 9.15.9.
**Outcome:** all 41 steps exited 0.

This file is the persisted ledger. Earlier Phase 05 records referred to "the ledger below"; the
ledger is here, and [Phase 05 remediation 3](phase-status.md#phase-05-remediation-3) points at this
file.

---

## 1. What this proves, and what it does not

It proves that at the accepted commit, every `run` step declared in the workflow — including the two
`if: always()` cleanup steps and the compose job's `docker compose ps`, which an earlier count of 40
had omitted — was executed in workflow order with the workflow's own command line, and that each
exited 0; and that the two Docker-backed jobs ran against disposable Compose projects that were
created and then fully removed, leaving the host's shared services untouched.

**It does not prove five independently pristine workspaces.** All five jobs ran sequentially in
**one** clone of the repository, so they shared one checkout, one `node_modules`, one pnpm store and
one Turborepo cache. The consequences are visible in the logs and are stated here rather than
implied:

- `pnpm install --frozen-lockfile` was a real install only in step 02. Steps 11, 21, 25 and 37
  reported `Lockfile is up to date` and `Already up to date` and finished in under half a second.
- `pnpm run build` was a real build only in step 16. Steps 28 and 39 were Turborepo cache hits —
  `17 successful, 17 cached … >>> FULL TURBO`, about 13 ms each.

On GitHub each job checks out and installs on its own runner, so a green run there additionally
proves that each job stands up from nothing. This ledger does not substitute for that, and a clean
code clone on its own says nothing about clean infrastructure — which is why the volume and project
evidence in §4 is recorded separately.

Also outside what this proves: the host is macOS, not `ubuntu-latest`; the `actions/checkout`,
`pnpm/action-setup` and `actions/setup-node` steps have no local equivalent and are not counted
among the 41 `run` steps.

## 2. Isolation

Each Docker-backed job ran under its own Compose project name, on ports chosen away from every
service already running on the host, with volumes created fresh by that project:

| Job | Compose project | PostgreSQL | Redis | MinIO | MinIO console | SMTP | Mailpit UI |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `compose` | `prsystem-ci-compose` | 55542 | 56479 | 59100 | 59101 | 51125 | 58125 |
| `gate-sec` | `prsystem-ci-gatesec` | 55643 | 56580 | 59202 | 59203 | 51226 | 58226 |

Every port was probed for occupancy before the job started, and the runner refused to start a job
whose ports were not free rather than binding over anything. The published bindings observed while
each project was up are in `compose-project-ps.txt` and `gatesec-project-ps.txt` (§5); all bindings
are on `127.0.0.1`.

The shared development project `prsystem` — the one this machine develops against — was never
addressed by any command in this ledger, and neither were the unrelated projects on the host.

## 3. The two deviations from the workflow

**A. Port-conflict retry (gate-sec).** The gate-sec job's first port set used TCP 55543 for
PostgreSQL. The pre-flight probe found it already bound by a macOS system service (`rapportd`),
unrelated to this project, so the run stopped before starting the job. The job was then re-executed
**unchanged** on the second free set listed in §2 (55643/56580/59202/59203/51226/58226). Steps 36–41
in the table below are that re-execution. Steps 01–35 were unaffected and were **not** re-run: the
compose job had already completed and removed its own volumes before the gate-sec job was reached.

**B. `REDIS_URL_TEST` override (six database steps).** The workflow sets only `DATABASE_URL` on its
database-backed steps, because on a GitHub runner the Compose services listen on their default
ports. The disposable projects here publish Redis on a non-default port, so the six database-backed
steps — 29, 30, 31, 32, 33 and 40 — additionally carried `REDIS_URL_TEST` pointing at that project's
Redis. Every other step ran with both variables explicitly unset. The `Env` column below records
this per step. No other command, flag or environment value differed from the workflow.

## 4. The 41 steps

Job order and step order are the workflow's. `Exit` is the process exit status. The log of each step
was retained outside the repository; its SHA-256 and size are recorded so a retained copy can be
identified. Two logs are empty because their commands print nothing on success (`playwright install`
with the browser already present, and `docker compose config --quiet`).

| # | Job | Workflow step | Command | Exit | Env | SHA-256 of the step log | Bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | `governance` | Scan for committed secrets before install | `node tools/scan-secrets.mjs` | 0 | both unset | `3a4339018f7d0141d3565b8708f33d46e320b837ba6338a9727ac3276f937aa8` | 53 |
| 02 | `governance` | Install (frozen lockfile) | `pnpm install --frozen-lockfile` | 0 | both unset | `989c4e162aaf67d12698cb8500aa8f22e1547170041cb370f119f9acf97883a4` | 737 |
| 03 | `governance` | Validate governance documents | `node tools/validate-governance.mjs` | 0 | both unset | `903ebc2dd34c508dddfe9c0df96e65c37423664d1c54da93d78b1e72e2bccea3` | 2492 |
| 04 | `governance` | Validate workspace structure | `node tools/validate-workspace.mjs` | 0 | both unset | `87b646b8ceebbd92584c8b7971d55609e42f96d7822eaf212f4baa26e9211641` | 1902 |
| 05 | `governance` | Validate regression coverage | `pnpm run validate:regression-coverage` | 0 | both unset | `42243c0ebee8d15da9a0e22c31b5aae54fcf42014429b1b2df4aeb90392dcd78` | 82905 |
| 06 | `governance` | Prove the coverage validator rejects CI bypasses | `pnpm run validate:ci-bypass-fixtures` | 0 | both unset | `0318fddab52d46b9ec6f28f9fd4f1eb16a34dc0082db02b1a2cda76086921086` | 6560 |
| 07 | `governance` | Prove the governance checks reject documentation drift | `pnpm run validate:governance-fixtures` | 0 | both unset | `01b381257c6c981a6547ff3f8ba092e61a2153412bd4e8d80e8f2608fc0a6981` | 16424 |
| 08 | `governance` | Prove the secret scanner cannot be masked by an allowed literal | `pnpm run validate:secret-scan-fixtures` | 0 | both unset | `835d3a87e764496e6a222a24753d4c2848576f05b53f95af7f61721fd2c98973` | 8199 |
| 09 | `governance` | Scan for committed secrets | `node tools/scan-secrets.mjs` | 0 | both unset | `3a4339018f7d0141d3565b8708f33d46e320b837ba6338a9727ac3276f937aa8` | 53 |
| 10 | `verify` | Scan for committed secrets before install | `node tools/scan-secrets.mjs` | 0 | both unset | `3a4339018f7d0141d3565b8708f33d46e320b837ba6338a9727ac3276f937aa8` | 53 |
| 11 | `verify` | Install (frozen lockfile) | `pnpm install --frozen-lockfile` | 0 | both unset | `957b161d07b64cb6fe0e94756b70c59d4b681127714d5eb546951a3cffbbb373` | 137 |
| 12 | `verify` | Format check | `pnpm run format:check` | 0 | both unset | `4e90d350996c3fe4d1f07a60065ce84df419ac1a5ac108000f59a41f9c10ffce` | 247 |
| 13 | `verify` | Lint | `pnpm run lint` | 0 | both unset | `35af60b7cf9e5b152f2cb7af002033f800129592d533bd02d1556c5544fe2b8a` | 6678 |
| 14 | `verify` | Typecheck | `pnpm run typecheck` | 0 | both unset | `aae7cc1051da4b97f9cec9d0bf299529f9629837996200b0dcd415888c70c863` | 11734 |
| 15 | `verify` | Unit tests | `pnpm run test:unit` | 0 | both unset | `0d6512f5bc7e02ed11b53b0cf00cd92d44e62797e21df266cd87c9cdf627f83e` | 18708 |
| 16 | `verify` | Build all applications | `pnpm run build` | 0 | both unset | `3b1e156ad08506301924649dc4744ea0aa2dc26ba8b9f7d9725002d868d44de5` | 15232 |
| 17 | `verify` | Generate OpenAPI document | `pnpm run openapi` | 0 | both unset | `96b212e1008d5433a202bf44de2c0547c36104f313d563f3c4891fbe8b78fc59` | 565 |
| 18 | `verify` | Audit production dependencies | `pnpm run audit:prod` | 0 | both unset | `efce12531e214f010e0c4716e1f49c3e271336d776986db125552d683d96613b` | 232 |
| 19 | `verify` | Audit full dependency tree | `pnpm run audit:tree` | 0 | both unset | `59c073a93054dc87a75325b61551e1b1a47d44133f9df3d6c60b6b2dffb1cdb8` | 235 |
| 20 | `e2e` | Scan for committed secrets before install | `node tools/scan-secrets.mjs` | 0 | both unset | `3a4339018f7d0141d3565b8708f33d46e320b837ba6338a9727ac3276f937aa8` | 53 |
| 21 | `e2e` | Install (frozen lockfile) | `pnpm install --frozen-lockfile` | 0 | both unset | `71300aa9beba6554d6c633e698f1f4ed8ca30c8225737c09cedd2c1a0568cd79` | 137 |
| 22 | `e2e` | Install Playwright browser | `pnpm exec playwright install --with-deps chromium` | 0 | both unset | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | 0 |
| 23 | `e2e` | Portal shell smoke tests | `pnpm run test:e2e` | 0 | both unset | `c9ed7c950dc8f01283f946e3f82564d779e2b0ac27c203aac45a18191313269a` | 12496 |
| 24 | `compose` | Scan for committed secrets before install | `node tools/scan-secrets.mjs` | 0 | both unset | `3a4339018f7d0141d3565b8708f33d46e320b837ba6338a9727ac3276f937aa8` | 53 |
| 25 | `compose` | Install (frozen lockfile) | `pnpm install --frozen-lockfile` | 0 | both unset | `f618d07db88a764d970097abfe3ea378e36130ed2dffe16777fbb917ca8333d8` | 137 |
| 26 | `compose` | Validate compose configuration | `docker compose config --quiet` | 0 | both unset | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | 0 |
| 27 | `compose` | Start backing services | `docker compose up -d --wait` | 0 | both unset | `6563d165c58bd0124704f0dabdf04812d9bcd9a0713b2211c3d0bc2b38da254b` | 1483 |
| 28 | `compose` | Build workspace packages from this checkout | `pnpm run build` | 0 | both unset | `db00287e378f376101418b95db22cae5051a942f2f7e720c660111af270406b5` | 15267 |
| 29 | `compose` | Migration gate against real PostgreSQL | `pnpm run test:migrations` | 0 | `DATABASE_URL`, `REDIS_URL_TEST` | `fa9866471d1fd76c4dd5bc2a3a9e651df665ba2e1822017bb91a4f59322587a5` | 19114 |
| 30 | `compose` | Integration gate against real PostgreSQL | `pnpm run test:integration` | 0 | `DATABASE_URL`, `REDIS_URL_TEST` | `d20196e149c82a52a950f04acd800525e3f3abfe8744a2357f78528f4f156121` | 34414 |
| 31 | `compose` | Concurrency gate against real PostgreSQL | `pnpm run test:concurrency` | 0 | `DATABASE_URL`, `REDIS_URL_TEST` | `37a027a1e0a178f1ba7b806094877ccf948f95dc2cde5d62fde228c9403d5b01` | 17899 |
| 32 | `compose` | Complete regression suite against real PostgreSQL | `pnpm run test:regression` | 0 | `DATABASE_URL`, `REDIS_URL_TEST` | `b2d09d4f229875bdd2395a4668ca363194bc53fcca3f38b254b06c1917a8d203` | 16834 |
| 33 | `compose` | Prove an unexpected idle-pool error fails an ordinary suite | `pnpm run validate:pool-error-fixture` | 0 | `DATABASE_URL`, `REDIS_URL_TEST` | `e710e86e709eb0a2fe7cd0cefa3b4a33d8b9877663d83a0570139bb9a34606b4` | 1254 |
| 34 | `compose` | Report service state (if: always) | `docker compose ps` | 0 | both unset | `cca81e62d2af6bf5e09aef9dbc1692e4f15727d9696b3aa136961fdfbe6a0d46` | 945 |
| 35 | `compose` | Stop backing services (if: always) | `docker compose down -v` | 0 | both unset | `e107a09dff6a2cace485a2d92bf827a5abf6212d4ecb277ba62ae45c950f6e57` | 1089 |
| 36 | `gate-sec` | Scan for committed secrets before install | `node tools/scan-secrets.mjs` | 0 | both unset | `3a4339018f7d0141d3565b8708f33d46e320b837ba6338a9727ac3276f937aa8` | 53 |
| 37 | `gate-sec` | Install (frozen lockfile) | `pnpm install --frozen-lockfile` | 0 | both unset | `f618d07db88a764d970097abfe3ea378e36130ed2dffe16777fbb917ca8333d8` | 137 |
| 38 | `gate-sec` | Start backing services | `docker compose up -d --wait` | 0 | both unset | `08b634647397b636d98ee530408c7351851ca7c458619dca4f295fc49aea31e6` | 1483 |
| 39 | `gate-sec` | Build workspace packages from this checkout | `pnpm run build` | 0 | both unset | `d27d7614782f87d1550478215bc69ebcf2cc11c871b95a924947c7f4adb875d8` | 15267 |
| 40 | `gate-sec` | Run the fail-closed security aggregator | `pnpm run test:security` | 0 | `DATABASE_URL`, `REDIS_URL_TEST` | `c5b0763eecad3753158c833a8ba02e332ac8883de23f690eb2b679aa5832c36d` | 130613 |
| 41 | `gate-sec` | Stop backing services (if: always) | `docker compose down -v` | 0 | both unset | `ab144c6a6a8df4d4faec708ba91bda0013da47d64dfbc6f5aa0fd91a49bdedd8` | 1089 |

## 5. Cleanup evidence

The host's Docker volume list was captured before the compose job started, after its
`docker compose down -v`, and after the gate-sec job's. Each disposable project's own volumes were
listed while the project was up.

| Capture | Contents |
| --- | --- |
| Before compose | 16 volumes, none of them `prsystem-ci-*` |
| `compose` project volumes, while up | `prsystem-ci-compose_postgres-data`, `prsystem-ci-compose_minio-data` |
| After `docker compose down -v` (step 35) | the same 16 volumes, byte-identical to the before capture |
| `gate-sec` project volumes, while up | `prsystem-ci-gatesec_postgres-data`, `prsystem-ci-gatesec_minio-data` |
| After `docker compose down -v` (step 41) | the same 16 volumes, byte-identical to the before capture |

The three host-wide captures hash identically
(`227b93b1ff4117dec2fc020d423786f36352115e23dda0117ef32e0cf9196afb`), which is the evidence that the
cleanup removed exactly the four volumes the two disposable projects had created and nothing else:
the shared `prsystem_postgres-data` and `prsystem_minio-data`, and every unrelated volume on the
host, are present in all three lists.

Supporting artifacts, with their hashes:

| Artifact | SHA-256 | Bytes |
| --- | --- | --- |
| `exits.txt` | `98e51835efe88ccf5b760d7aa80a2ec0b30831ce31d32f1c015ed59463e5ac5b` | 1645 |
| `volumes-before-compose.txt` | `227b93b1ff4117dec2fc020d423786f36352115e23dda0117ef32e0cf9196afb` | 787 |
| `volumes-compose-disposable.txt` | `e089e142c28a16a02151e103c812491a116343d1d1854ae3ab95e3fb6652b6e1` | 65 |
| `volumes-after-compose.txt` | `227b93b1ff4117dec2fc020d423786f36352115e23dda0117ef32e0cf9196afb` | 787 |
| `volumes-gatesec-disposable.txt` | `1832f7cd61baa85b9b79abcf07f9cb76d2f8ad0e8b11dc8509952fad21af91b4` | 65 |
| `volumes-after-gatesec.txt` | `227b93b1ff4117dec2fc020d423786f36352115e23dda0117ef32e0cf9196afb` | 787 |
| `compose-project-ps.txt` | `d94a39e31df0216f44524e9fb98c3b3fd731526bbb3f91d6303c567061dab6f5` | 275 |
| `gatesec-project-ps.txt` | `ff8cd2d4c7aa6e0b2adc2d222a442e7cd11b335edb418b116eb7becf18a79f5f` | 275 |

`exits.txt` is the machine-written record the table in §4 was generated from: one
`step|job|command|exit` line per step, 41 lines.

## 6. Relation to the Phase 05 battery

This ledger is **not** the phase battery. The governed Phase 05 battery — its 24 commands, the
three-times multiplicities for concurrency and security, and its measured results — is the frozen
evidence recorded in [Phase 05 remediation 3](phase-status.md#phase-05-remediation-3), measured at
implementation commit `0c67eca1fc687b443199d3ff11114d68285d9f60` and validated by
`validate-governance` check 16 against
[`phase-05-evidence.json`](phase-05-evidence.json). This ledger is a separate, later execution of
the CI workflow's step list at the accepted commit `35314ba`. Neither restates the other's counts,
and neither is re-run to confirm the other.
