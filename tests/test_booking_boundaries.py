import unittest
try:
    from fastapi.testclient import TestClient
    from prsystem.api import create_app,BookingBeneficiary,RestaurantLink
    from prsystem.booking_public import BookingPublic
    from pydantic import ValidationError
    AVAILABLE=True
except ImportError:
    AVAILABLE=False

@unittest.skipUnless(AVAILABLE,'Optional API dependencies are not installed')
class BookingBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client=TestClient(create_app('postgresql://unused:unused@127.0.0.1:1/prsystem_test_closed'))
        cls.addClassCleanup(cls.client.close)
    def test_new_mock_surfaces_fail_closed_without_database_or_provider_calls(self):
        headers={'Authorization':'Bearer '+'x'*43}
        cases=[('get','/public/booking-hotels?planned_checkin_at=2026-10-10T06:00:00Z&nights=2',None),
            ('post','/booker/auth/challenge',dict(phone='99112233',purpose='REGISTER',device='device-12345678901234567890')),
            ('post','/platform/hotels/t/booking-holds/b/settlement',{}),
            ('post','/platform/hotels/t/booking-payouts',dict(idempotency_key='test'))]
        for method,path,body in cases:
            with self.subTest(path=path):
                kwargs=dict(headers=headers)
                if body is not None:kwargs['json']=body
                self.assertEqual(getattr(self.client,method)(path,**kwargs).status_code,503)
    def test_bank_commands_reject_client_authority_and_untrusted_image_sources(self):
        for body in [dict(idempotency_key='key',paid=True),dict(idempotency_key='key',amount_mnt=100)]:
            with self.assertRaises(ValidationError):RestaurantLink.model_validate(body)
        with self.assertRaises(ValidationError):BookingBeneficiary.model_validate(dict(reference='bank',expected_revision=True,idempotency_key='key'))
        from prsystem.common import DomainError
        for value in ['https://private.example/image.png','data:image/svg+xml;base64,PHN2Zz4=','data:image/png;base64,aW52YWxpZA==']:
            with self.assertRaises(DomainError):BookingPublic.photos([value])
