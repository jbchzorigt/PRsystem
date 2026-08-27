# ADR-0020 — Envelope encryption behind a provider-neutral KeyManagementPort

**Status:** Accepted · **Date:** Phase 01 · **Closes:** DM-04
**Relates to:** ADR-0012 (ports and simulators), ADR-0005 (realms), ADR-0016 (fail closed)

## Context

Registration numbers, passport numbers and other government identifiers are stored encrypted, and
exact matching uses a keyed lookup token rather than the plaintext (`RC-DEC-044`, doc 13 §6.3).
`04-logical-data-model.md` left key management open as **DM-04**. No KMS provider is contracted, and
EXT-10 has not cleared.

## Decision

1. **Provider-neutral port.** Define `KeyManagementPort` in `packages/ports`, following ADR-0012:

   ```ts
   interface KeyManagementPort {
     wrap(scope: KeyScope, dek: Uint8Array): Promise<{ wrapped: Uint8Array; keyVersion: string }>;
     unwrap(scope: KeyScope, wrapped: Uint8Array, keyVersion: string): Promise<Uint8Array>;
     currentVersion(scope: KeyScope): Promise<string>;
     hmac(scope: HmacScope, input: Uint8Array): Promise<{ mac: Uint8Array; keyVersion: string }>;
   }
   type KeyScope  = 'pii.hotel_guest' | 'pii.police';
   type HmacScope = 'lookup.identity' | 'lookup.police_identity';
   ```

2. **Envelope encryption with versioned DEKs.** Data is encrypted with a data-encryption key; the DEK
   is wrapped by a key-encryption key held in the production KMS or secret manager. DEKs are
   versioned.
3. **Key version stored with ciphertext.** Every encrypted column stores `key_version` alongside the
   ciphertext, so rotation does not require a synchronous rewrite and old data stays readable.
4. **Rotation and rewrapping supported.** A new version is introduced for new writes; a background
   rewrapping job re-encrypts existing rows under `prsystem_maintenance`, resumable and audited.
5. **Separate key scopes per realm.** Hotel/Guest PII keys and Police keys are distinct scopes with
   distinct KEKs and distinct access grants. Compromise of one realm's key material does not expose
   the other. This is the cryptographic counterpart to ADR-0005 and ADR-0017.
6. **Keyed HMAC for lookup, never an unkeyed hash.** Exact-match lookup tokens use a versioned keyed
   HMAC secret, namespaced by identity type and country. An unkeyed hash of a national identifier is
   trivially reversible by enumeration and is prohibited. The HMAC secret is a separate scope from the
   encryption keys, and Police lookup uses its own scope.
7. **Development simulator.** Development and CI use a deterministic local simulator with synthetic
   data only. It is never enabled outside those environments.
8. **Production fails closed.** If the approved KMS is unreachable or a required key version is
   unavailable, operations needing it fail with a typed error. The system never falls back to a local
   key, never writes plaintext, and never skips the lookup token.
9. **Plaintext keys never persist.** No key material appears in source, database rows, logs, traces,
   fixtures, seeds or audit payloads. `key_version` is an identifier and is safe to record; key bytes
   are not.

## Alternatives rejected

- **Application-level static key from configuration.** No rotation story, no separation between
  realms, and the key would sit in an environment variable readable by every process.
- **PostgreSQL `pgcrypto` with a database-held key.** Places key material in the same blast radius as
  the ciphertext.
- **Unkeyed SHA-256 lookup token.** The identifier space for a national registration number is small
  enough to enumerate; an unkeyed digest is not a protection.
- **Transparent disk encryption alone.** Protects a stolen disk, not a compromised query path or an
  over-broad grant.

## Consequences

- Encryption and lookup become port calls, so the KMS choice is deferred to Phase 20 without blocking
  Phases 03–19.
- Key version columns are part of the schema from the first migration that stores an identifier.
- Rotation is an operational procedure with a rewrapping job, defined when the port is implemented.
- A KMS outage degrades identifier-dependent flows — check-in identity capture, Police matching — into
  explicit failures rather than silent weakening. That is the intended trade.

## Verification

| Test | Gate | Asserts |
| --- | --- | --- |
| Round trip | `GATE-UNIT` | Encrypt/decrypt and HMAC are stable across key versions |
| Rotation | `GATE-INTEG` | Data written under version N remains readable after version N+1 is current |
| Rewrapping | `GATE-INTEG` | The rewrap job is resumable and changes no plaintext |
| Scope separation | `GATE-INTEG` | A Police-scope unwrap request from a Hotel-scope context is refused |
| Keyed lookup | `GATE-UNIT` | Lookup tokens differ across identity-type and country namespaces for the same input |
| Fail closed | `GATE-INTEG` | With the KMS unavailable, the operation fails; nothing is written in plaintext |
| No leakage | `GATE-SEC` | Planted key-material canaries appear in no log, trace, fixture, seed or audit payload |
