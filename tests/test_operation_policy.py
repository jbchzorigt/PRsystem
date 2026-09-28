import tempfile
import unittest
from datetime import datetime,timedelta,timezone
from pathlib import Path
from prsystem.common import DomainError
from prsystem.operation_policy import status,phone,masked,message,mock_quote
from prsystem.mock_providers import MockStore,MockSMSGateway,MockEbarimtGateway


class OperationPolicyTests(unittest.TestCase):
    def test_status_boundaries_and_suspension_override(self):
        now=datetime(2026,9,14,tzinfo=timezone.utc)
        for seconds,expected in [(168*3600+1,'ACTIVE'),(168*3600,'EXPIRING'),(1,'EXPIRING'),(0,'GRACE'),(-48*3600+1,'GRACE'),(-48*3600,'EXPIRED')]:
            with self.subTest(seconds=seconds):
                result=status(now+timedelta(seconds=seconds),now)
                self.assertEqual(result['status'],expected)
                suspended=status(now+timedelta(seconds=seconds),now,True)
                self.assertEqual((suspended['status'],suspended['underlying_status']),('SUSPENDED',expected))

    def test_phone_normalization_deduplicates_mongolian_formats(self):
        for value in ['99112233','97699112233','+97699112233']:
            self.assertEqual(phone(value),'+97699112233')
        for value in ['',None,'9911-2233','９９１１２２３３','+099112233']:
            self.assertIsNone(phone(value))

    def test_masking_does_not_return_local_email_or_full_phone(self):
        self.assertEqual(masked('owner@example.test'),'o***@example.test')
        self.assertNotIn('99112233',masked('+97699112233'))

    def test_text_trim_and_character_limit(self):
        self.assertEqual(message('  Сунгалт хийнэ үү.  '),'Сунгалт хийнэ үү.')
        for invalid in ['', ' '*10,'а'*301]:
            with self.assertRaises(DomainError):message(invalid)

    def test_mock_segments_and_cost_are_separate_from_character_limit(self):
        self.assertEqual(mock_quote('а'*70,2,5)['estimated_cost_mnt'],10)
        self.assertEqual(mock_quote('а'*71,2,5)['total_segments'],4)
        self.assertEqual(mock_quote('🙂'*35,1)['segments_per_recipient'],1)
        self.assertEqual(mock_quote('🙂'*36,1)['segments_per_recipient'],2)
        self.assertEqual(mock_quote('а'*300,0)['estimated_cost_mnt'],0)


class OperationMockTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.store=MockStore(Path(self.temp.name)/'providers.sqlite3',environment='test')
        self.sms=MockSMSGateway(self.store)

    def test_send_replay_and_restart_keep_same_message(self):
        first=self.sms.send('r','+97699112233','Сануулах',1)
        restarted=MockSMSGateway(self.store)
        self.assertEqual(restarted.send('r','+97699112233','Сануулах',1),first)
        with self.store.connect() as conn:self.assertEqual(conn.execute('SELECT count(*) FROM mock_sms').fetchone()[0],1)
        with self.assertRaises(DomainError):self.sms.send('r','+97699112233','Өөр текст',1)

    def test_unknown_is_observed_without_new_delivery(self):
        self.sms.send('r','+97699112233','Сануулах',1);self.sms.set_status('r',1,'UNKNOWN')
        self.assertEqual(self.sms.lookup('r',1)['state'],'UNKNOWN')
        self.sms.set_status('r',1,'DELIVERED');self.assertEqual(self.sms.lookup('r',1)['state'],'DELIVERED')

    def test_confirmed_failure_can_use_new_attempt_key(self):
        self.sms.send('r','+97699112233','Сануулах',1);self.sms.set_status('r',1,'FAILED')
        self.assertEqual(self.sms.send('r','+97699112233','Сануулах',2)['attempt'],2)
        self.assertEqual(self.sms.lookup('r',1)['state'],'FAILED')

    def test_mock_receipt_retains_immutable_amount_and_email(self):
        gateway=MockEbarimtGateway(self.store);snapshot=dict(amount_mnt=20000,email='owner@example.test')
        first=gateway.issue('job',snapshot)
        self.assertEqual(gateway.lookup('job'),first);self.assertEqual(gateway.issue('job',snapshot),first)
        self.assertEqual(first['mode'],'MOCK_ONLY');self.assertIn('NOT-FISCAL',first['receipt_id'])
        with self.assertRaises(DomainError):gateway.issue('job',{**snapshot,'email':'attacker@example.test'})
