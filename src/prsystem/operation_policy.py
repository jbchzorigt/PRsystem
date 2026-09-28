"""Operation projections and mock SMS quoting; no provider contract implied."""
import math
import re
from datetime import timedelta
from prsystem.common import DomainError


STATUSES=('ACTIVE','EXPIRING','GRACE','EXPIRED','SUSPENDED')


def status(expiry,as_of,suspended=False):
    remaining=(expiry-as_of).total_seconds()
    underlying='ACTIVE' if remaining>168*3600 else 'EXPIRING' if remaining>0 else 'GRACE' if remaining>-48*3600 else 'EXPIRED'
    return dict(status='SUSPENDED' if suspended else underlying,underlying_status=underlying,days_left=math.ceil(remaining/86400))


def phone(value):
    if not isinstance(value,str):return None
    value=value.strip()
    if re.fullmatch(r'[0-9]{8}',value):return '+976'+value
    if re.fullmatch(r'976[0-9]{8}',value):return '+'+value
    if re.fullmatch(r'\+[1-9][0-9]{7,14}',value):return value
    return None


def masked(value):
    if not value:return '—'
    if '@' in value:
        local,domain=value.rsplit('@',1)
        return local[:1]+'***@'+domain
    return value[:4]+'****'+value[-2:]


def message(value):
    if not isinstance(value,str) or not 1<=len(value.strip())<=300:raise DomainError('INVALID_REQUEST')
    try:value.encode('utf-8')
    except UnicodeError:raise DomainError('INVALID_REQUEST') from None
    return value.strip()


def mock_quote(text,recipients,segment_price_mnt=0):
    """Mock uses a declared UTF-16 70/67-unit tariff, even for ASCII.

    Production adapters must supply their own approved encoding/tariff quote.
    A zero mock tariff is simulation only, never a real CallPro price.
    """
    text=message(text)
    if type(recipients) is not int or recipients<0 or type(segment_price_mnt) is not int or segment_price_mnt<0:raise ValueError('Invalid SMS quote')
    units=len(text.encode('utf-16-be'))//2
    segments=1 if units<=70 else math.ceil(units/67)
    return dict(mode='MOCK_ONLY',encoding='UTF16_MOCK',characters=len(text),units=units,segments_per_recipient=segments,
                recipient_count=recipients,total_segments=segments*recipients,estimated_cost_mnt=segments*recipients*segment_price_mnt)
