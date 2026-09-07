"""RFC 6238/HOTP dynamic truncation. Enrollment secrets stay outside this DB."""
import hmac
import struct


def totp(secret: bytes, counter: int, digits=6):
    if not isinstance(secret,bytes) or len(secret)<20 or type(counter) is not int or counter<0 or digits not in (6,8):
        raise ValueError('Invalid TOTP parameters')
    mac=hmac.digest(secret,struct.pack('>Q',counter),'sha1')
    offset=mac[-1]&15
    number=int.from_bytes(mac[offset:offset+4],'big')&0x7fffffff
    return str(number % (10**digits)).zfill(digits)
