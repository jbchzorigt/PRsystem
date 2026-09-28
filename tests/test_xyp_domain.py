"""ХУР port evidence rules and the development mock adapter (no database)."""
import unittest
from datetime import date
from tempfile import TemporaryDirectory

from prsystem.common import DomainError
from prsystem.guest_identity import registration_number
from prsystem.mock_providers import MockStore, MockXypGateway
from prsystem.xyp import XypNotFound, XypUnavailable, citizen_evidence


class RegistrationNumberTests(unittest.TestCase):
    def test_normalizes_and_decodes_birth_date(self):
        self.assertEqual(registration_number(' аб90010211 '), ('АБ90010211', date(1990, 1, 2)))
        self.assertEqual(registration_number('АБ15210211'), ('АБ15210211', date(2015, 1, 2)))

    def test_rejects_malformed_numbers(self):
        for value in ('AB90010211', 'АБ90133211', 'АБ9001021', None):
            with self.subTest(value=value), self.assertRaisesRegex(DomainError, 'INVALID_GUEST_IDENTITY'):
                registration_number(value)


class CitizenEvidenceTests(unittest.TestCase):
    def test_accepts_complete_matching_answer(self):
        self.assertEqual(citizen_evidence('АБ90010211', dict(family_name=' Туршилт ', given_name='Зочин', date_of_birth='1990-01-02')),
                         dict(document_number='АБ90010211', family_name='Туршилт', given_name='Зочин', date_of_birth='1990-01-02'))

    def test_incomplete_or_mismatched_answer_is_unusable(self):
        for raw in (dict(family_name='Туршилт', given_name='Зочин'), dict(family_name='', given_name='Зочин', date_of_birth='1990-01-02'),
                    dict(family_name='Туршилт', given_name='Зочин', date_of_birth='1990-01-03'), None):
            with self.subTest(raw=raw), self.assertRaises(XypUnavailable) as caught:
                citizen_evidence('АБ90010211', raw)
            self.assertEqual(caught.exception.reason, 'INVALID_EVIDENCE')


class MockXypGatewayTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory(); self.addCleanup(directory.cleanup)
        self.gateway = MockXypGateway(MockStore(directory.name + '/xyp.sqlite3', environment='test'))
        self.gateway.add_citizen('АБ90010211', 'Туршилт', 'Зочин', '1990-01-02')

    def test_found_not_found_and_outages(self):
        self.assertEqual(self.gateway.citizen('АБ90010211'), dict(family_name='Туршилт', given_name='Зочин', date_of_birth='1990-01-02'))
        with self.assertRaises(XypNotFound): self.gateway.citizen('АБ85020311')
        with self.assertRaises(XypUnavailable): self.gateway.citizen(MockXypGateway.OUTAGE)
        self.gateway.set_available(False)
        with self.assertRaises(XypUnavailable): self.gateway.citizen('АБ90010211')
        self.assertEqual(self.gateway.calls, 4)

    def test_mock_store_refuses_production_mode(self):
        with TemporaryDirectory() as directory, self.assertRaises(ValueError):
            MockXypGateway(MockStore(directory + '/xyp.sqlite3', environment='production'))
