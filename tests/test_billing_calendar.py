import unittest
from datetime import datetime,timedelta,timezone
from zoneinfo import ZoneInfo
from prsystem.billing import add_months,quote,renewal_window
from prsystem.common import DomainError

class BillingCalendarTests(unittest.TestCase):
    def test_all_twelve_canonical_prices(self):
        for p in (20000,25000,30000):
            for m in (1,3,7,12):self.assertEqual(quote(p,m),p*m)
        for p,m in [(True,1),(20000,True),(20000,2),(15000,12)]:
            with self.assertRaises(DomainError):quote(p,m)

    def test_calendar_end_of_month_and_leap_year(self):
        local=ZoneInfo('Asia/Ulaanbaatar')
        self.assertEqual(add_months(datetime(2024,1,31,23,30,tzinfo=local),1),datetime(2024,2,29,23,30,tzinfo=local))
        self.assertEqual(add_months(datetime(2024,1,31,23,30,tzinfo=local),3),datetime(2024,4,30,23,30,tzinfo=local))

    def test_grace_boundary_is_exclusive(self):
        expiry=datetime(2026,1,31,2,tzinfo=timezone.utc)
        self.assertEqual(renewal_window(expiry,expiry+timedelta(hours=48)-timedelta(microseconds=1),1)[0],expiry)
        self.assertEqual(renewal_window(expiry,expiry+timedelta(hours=48),1)[0],expiry+timedelta(hours=48))
