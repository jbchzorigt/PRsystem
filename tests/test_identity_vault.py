import importlib.util
import unittest
from prsystem.guest_identity import IdentityVault
from prsystem.common import DomainError


@unittest.skipUnless(importlib.util.find_spec('cryptography'),'API crypto extra is not installed')
class IdentityVaultTests(unittest.TestCase):
    def setUp(self):
        self.vault=IdentityVault({'v1':b'a'*32},'v1',b'b'*32)

    def test_ciphertexts_are_random_and_bound_to_tenant_stay_purpose(self):
        value={'document_number':'АБ90010211','name':'Private'}
        first=self.vault.seal(value,'hotel','stay')
        self.assertNotEqual(first,self.vault.seal(value,'hotel','stay'))
        self.assertEqual(self.vault.open(first,'hotel','stay'),value)
        for tenant,stay,purpose in [('other','stay','identity'),('hotel','other','identity'),('hotel','stay','guest-code')]:
            with self.assertRaises(DomainError):self.vault.open(first,tenant,stay,purpose)

    def test_key_rotation_keeps_old_reads_and_stable_lookup(self):
        sealed=self.vault.seal('private','hotel','stay')
        rotated=IdentityVault({'v1':b'a'*32,'v2':b'c'*32},'v2',b'b'*32)
        self.assertEqual(rotated.open(sealed,'hotel','stay'),'private')
        self.assertEqual(rotated.fingerprint('exact',['MN','123']),self.vault.fingerprint('exact',['MN','123']))
        self.assertEqual(rotated.seal('new','hotel','stay')['key_id'],'v2')

    def test_exact_tokens_have_type_country_and_purpose_namespaces(self):
        original=self.vault.fingerprint('exact',['MN_REG_NO','MN','123'])
        self.assertNotEqual(original,self.vault.fingerprint('command',['MN_REG_NO','MN','123']))
        self.assertNotEqual(original,self.vault.fingerprint('exact',['FOREIGN_PASSPORT','MN','123']))
        self.assertNotEqual(original,self.vault.fingerprint('exact',['MN_REG_NO','US','123']))

    def test_missing_old_key_and_tampered_envelope_fail_closed(self):
        sealed=self.vault.seal('private','hotel','stay')
        with self.assertRaises(DomainError):IdentityVault({'v2':b'c'*32},'v2',b'b'*32).open(sealed,'hotel','stay')
        sealed['ciphertext']=sealed['ciphertext'][:-4]+'AAAA'
        with self.assertRaises(DomainError):self.vault.open(sealed,'hotel','stay')
