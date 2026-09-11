import unittest
from prsystem.mfa import totp

class TotpVectorTests(unittest.TestCase):
    def test_rfc6238_sha1_vectors(self):
        for seconds,expected in [(59,'94287082'),(1111111109,'07081804'),(1111111111,'14050471'),(1234567890,'89005924'),(2000000000,'69279037'),(20000000000,'65353130')]:
            self.assertEqual(totp(b'12345678901234567890',seconds//30,8),expected)

    def test_invalid_keys_and_counter(self):
        for key,counter in [(b'short',1),(b'x'*20,-1),(b'x'*20,True)]:
            with self.assertRaises(ValueError):totp(key,counter)
