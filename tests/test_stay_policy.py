import unittest
from datetime import datetime, date, time, timedelta, timezone
from prsystem.common import DomainError
from prsystem.stay_policy import actual_time, stay_terms, overlaps, HOTEL_ZONE
from prsystem.guest_identity import validate_identity


class StayPolicyTests(unittest.TestCase):
    now = datetime(2026, 9, 7, 10, tzinfo=HOTEL_ZONE)

    def test_half_hour_rounding_once_and_integer_only(self):
        end, amount = stay_terms('HOURLY', 3, self.now, self.now, 10001, time(12))
        self.assertEqual(end, self.now+timedelta(minutes=90)); self.assertEqual(amount, 15002)
        for units in (0, -1, True, 1.5, 2**63):
            with self.subTest(units=units), self.assertRaises(DomainError):
                stay_terms('HOURLY', units, self.now, self.now, 10001, time(12))

    def test_nights_use_next_calendar_day_even_before_checkout(self):
        end, amount = stay_terms('NIGHTLY', 1, self.now, self.now, 80000, time(12))
        self.assertEqual(end, datetime(2026, 9, 8, 12, tzinfo=HOTEL_ZONE)); self.assertEqual(amount, 80000)
        late = datetime(2026, 12, 31, 23, 59, tzinfo=HOTEL_ZONE)
        self.assertEqual(stay_terms('NIGHTLY', 1, late, late, 1, time(12))[0], datetime(2027, 1, 1, 12, tzinfo=HOTEL_ZONE))

    def test_actual_boundaries_reason_future_and_timezone(self):
        opened = self.now-timedelta(hours=3)
        earliest = self.now-timedelta(minutes=120)
        self.assertEqual(actual_time(self.now, opened, earliest, 'Зөв цаг'), earliest)
        for value in (earliest-timedelta(microseconds=1), self.now+timedelta(microseconds=1), self.now.replace(tzinfo=None)):
            with self.assertRaises(DomainError): actual_time(self.now, opened, value, 'reason')
        with self.assertRaisesRegex(DomainError, 'INVALID_REASON'): actual_time(self.now, opened, earliest)

    def test_shift_and_local_midnight_clamp_backdate(self):
        opened = self.now-timedelta(minutes=30)
        with self.assertRaises(DomainError): actual_time(self.now, opened, opened-timedelta(seconds=1), 'reason')
        midnight = datetime(2026, 9, 7, 0, 30, tzinfo=HOTEL_ZONE)
        with self.assertRaises(DomainError): actual_time(midnight, midnight-timedelta(hours=3), midnight-timedelta(minutes=31), 'reason')

    def test_backdated_hourly_end_must_still_be_in_future(self):
        with self.assertRaisesRegex(DomainError, 'STAY_ALREADY_ENDED'):
            stay_terms('HOURLY', 2, self.now-timedelta(hours=1), self.now, 10000, time(12))

    def test_half_open_intervals_and_both_buffers(self):
        end = self.now+timedelta(hours=1)
        self.assertFalse(overlaps(self.now, end, end, end+timedelta(hours=1)))
        self.assertTrue(overlaps(self.now, end, end, end+timedelta(hours=1), 30))
        self.assertFalse(overlaps(self.now, end, end+timedelta(minutes=30), end+timedelta(hours=1), 30))
        self.assertTrue(overlaps(end, end+timedelta(hours=1), self.now, end, 0, 30))

    def test_currency_and_calendar_overflow_fail_closed(self):
        for kind, units, price in [('NIGHTLY', 999999999, 1), ('NIGHTLY', 2, 2**63-1), ('HOURLY', 3, 2**63-1)]:
            with self.assertRaises(DomainError): stay_terms(kind, units, self.now, self.now, price, time(12))


class GuestIdentityPolicyTests(unittest.TestCase):
    day = date(2026, 9, 7)

    def guest(self, **extra):
        return dict(identity_type='MN_REG_NO',family_name='Бат',given_name='Болд',date_of_birth='1990-01-02',nationality='MN',document_number='аб90010211',**extra)

    def test_registration_normalizes_and_never_asserts_xyp(self):
        guest, exact = validate_identity(self.guest(), self.day)
        self.assertEqual(exact, ('MN_REG_NO','MN','АБ90010211'))
        self.assertEqual((guest['provenance'],guest['age_at_checkin']), ('MANUAL',36))

    def test_invalid_registration_dates_latin_lookalikes_and_dob_mismatch(self):
        for number in ('AB90010211','АБ90133211','АБ90010311','АБ9001021','АБ900102１1'):
            data = self.guest();data['document_number'] = number
            with self.subTest(number=number), self.assertRaises(DomainError): validate_identity(data,self.day)

    def test_child_needs_guardian_and_remains_rd_match_eligible(self):
        data = self.guest(); data.update(date_of_birth='2015-01-02', document_number='АБ15210211')
        with self.assertRaisesRegex(DomainError,'GUARDIAN_REQUIRED'): validate_identity(data,self.day)
        data['guardian'] = dict(name='Эцэг',phone='99112233',relationship='father')
        guest, exact = validate_identity(data,self.day)
        self.assertEqual(guest['age_at_checkin'],11);self.assertEqual(exact[0],'MN_REG_NO')

    def test_passport_other_id_and_no_document(self):
        base = dict(family_name='Test',given_name='Guest',date_of_birth='2000-09-08',nationality='US')
        guest, exact = validate_identity(dict(base,identity_type='FOREIGN_PASSPORT',document_number='p123',issuing_country='us',expiry_date='2030-01-01'),self.day)
        self.assertEqual(guest['age_at_checkin'],25);self.assertEqual(exact,('FOREIGN_PASSPORT','US','P123'))
        self.assertEqual(validate_identity(dict(base,identity_type='OTHER_GOV_ID',document_number='123',issuing_country='US',document_type='STATE_ID',issuing_authority='State'),self.day)[1][0],'OTHER_GOV_ID')
        guest, exact = validate_identity(dict(base,identity_type='NO_DOCUMENT',no_document_reason='Lost',note='Manual entry'),self.day)
        self.assertIsNone(exact);self.assertEqual(guest['assurance'],'LOW_ASSURANCE')

    def test_mixed_identity_fields_and_future_dob_rejected(self):
        for changes in (dict(expiry_date='2030-01-01'),dict(date_of_birth='2027-01-01')):
            data=self.guest();data.update(changes)
            with self.assertRaises(DomainError):validate_identity(data,self.day)
