"""Manual primary-guest validation. No request can assert XYP verification.

Identifiers and all guest metadata are encrypted together. HMAC namespaces are
separate for exact identifier lookup and command fingerprints; no plain hashes
of low-entropy identity values are stored. No Police outcomes enter hotel data.
"""
import base64
import hashlib
import hmac
import json
import re
import secrets
from datetime import date
from prsystem.common import DomainError


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def text(value, maximum=200):
    if not isinstance(value, str) or not 0 < len(value.strip()) <= maximum or any(ord(c) < 32 for c in value):
        raise DomainError('INVALID_GUEST_IDENTITY')
    return value.strip()


def calendar_date(value):
    try:
        if not isinstance(value, str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', value):
            raise ValueError()
        return date.fromisoformat(value)
    except ValueError as exc:
        raise DomainError('INVALID_GUEST_IDENTITY') from exc


def validate_identity(data, on_date):
    kind = data['identity_type']
    result = {name: text(data.get(name)) for name in ('family_name', 'given_name', 'nationality')}
    dob = calendar_date(data.get('date_of_birth'))
    if dob > on_date:
        raise DomainError('INVALID_GUEST_IDENTITY')
    age = on_date.year - dob.year - ((on_date.month, on_date.day) < (dob.month, dob.day))
    result.update(identity_type=kind, date_of_birth=dob.isoformat(), age_at_checkin=age, provenance='MANUAL',
                  matching_eligibility='ELIGIBLE_EXACT_RD' if kind == 'MN_REG_NO' else 'NOT_ELIGIBLE_EXACT_RD')
    identifier = country = None
    required = set()
    if kind == 'MN_REG_NO':
        required = {'document_number'}
        identifier = text(data.get('document_number')).upper()
        if not re.fullmatch(r'[А-ЯЁӨҮ]{2}[0-9]{8}', identifier):
            raise DomainError('INVALID_GUEST_IDENTITY')
        yy, mm, dd = int(identifier[2:4]), int(identifier[4:6]), int(identifier[6:8])
        try:
            rd_dob = date(2000 + yy if mm > 20 else 1900 + yy, mm - 20 if mm > 20 else mm, dd)
        except ValueError as exc:
            raise DomainError('INVALID_GUEST_IDENTITY') from exc
        if rd_dob != dob:
            raise DomainError('INVALID_GUEST_IDENTITY')
        country = 'MN'
    elif kind in {'FOREIGN_PASSPORT', 'OTHER_GOV_ID'}:
        required = {'document_number', 'issuing_country'}
        country = text(data.get('issuing_country')).upper()
        if not re.fullmatch(r'[A-Z]{2}', country):
            raise DomainError('INVALID_GUEST_IDENTITY')
        identifier = text(data.get('document_number')).upper()
        result['issuing_country'] = country
        if kind == 'FOREIGN_PASSPORT':
            required.add('expiry_date')
            result['expiry_date'] = calendar_date(data.get('expiry_date')).isoformat()
        else:
            required |= {'document_type', 'issuing_authority'}
            result['document_type'] = text(data.get('document_type'))
            result['issuing_authority'] = text(data.get('issuing_authority'))
    elif kind == 'NO_DOCUMENT':
        required = {'no_document_reason', 'note'}
        result.update(no_document_reason=text(data.get('no_document_reason'), 1000), note=text(data.get('note'), 2000), assurance='LOW_ASSURANCE')
    else:
        raise DomainError('INVALID_GUEST_IDENTITY')
    specific = {'document_number', 'issuing_country', 'expiry_date', 'document_type', 'issuing_authority', 'no_document_reason', 'note'}
    if any(data.get(field) is not None for field in specific - required):
        raise DomainError('INVALID_GUEST_IDENTITY')
    guardian = data.get('guardian')
    if age < 18 and guardian is None:
        raise DomainError('GUARDIAN_REQUIRED')
    if guardian is not None:
        result['guardian'] = {field: text(guardian.get(field)) for field in ('name', 'phone', 'relationship')}
    if identifier:
        result['document_number'] = identifier
    return result, (kind, country, identifier) if identifier else None


class IdentityVault:
    """Versioned AES-256-GCM envelopes; retain old keys for reads/rotation.

    Separate stable lookup/fingerprint key must survive encryption key rotation.
    AAD binds ciphertext to its tenant, stay, and purpose.
    """
    def __init__(self, keys, current_key, lookup_key):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        if not keys or current_key not in keys or any(not isinstance(k, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', k) or len(v) != 32 for k, v in keys.items()) or len(lookup_key) != 32 or lookup_key in keys.values():
            raise ValueError('Invalid identity key configuration')
        self.keys = {k: AESGCM(v) for k, v in keys.items()}
        self.current_key = current_key
        self.lookup_key = lookup_key

    def fingerprint(self, purpose, value):
        return hmac.new(self.lookup_key, canonical([purpose, value]), hashlib.sha256).hexdigest()

    def seal(self, value, tenant, stay, purpose='identity'):
        nonce = secrets.token_bytes(12)
        aad = canonical(['prsystem-v1', self.current_key, tenant, stay, purpose])
        encrypted = self.keys[self.current_key].encrypt(nonce, canonical(value), aad)
        return dict(key_id=self.current_key, ciphertext=base64.b64encode(nonce + encrypted).decode())

    def open(self, envelope, tenant, stay, purpose='identity'):
        from cryptography.exceptions import InvalidTag
        try:
            raw = base64.b64decode(envelope['ciphertext'], validate=True)
            key_id = envelope['key_id']
            aad = canonical(['prsystem-v1', key_id, tenant, stay, purpose])
            return json.loads(self.keys[key_id].decrypt(raw[:12], raw[12:], aad))
        except (KeyError, ValueError, InvalidTag) as exc:
            raise DomainError('IDENTITY_VAULT_UNAVAILABLE') from exc


def vault_from_environment():
    import os
    raw = os.environ.get('PRSYSTEM_IDENTITY_KEYS')
    if raw is None:
        return None
    keys = {key: base64.b64decode(value, altchars=b'-_', validate=True) for key, value in json.loads(raw).items()}
    lookup = base64.b64decode(os.environ['PRSYSTEM_IDENTITY_LOOKUP_KEY'], altchars=b'-_', validate=True)
    return IdentityVault(keys, os.environ['PRSYSTEM_IDENTITY_CURRENT_KEY'], lookup)
