"""Calendar-month billing helpers. No client price or duration arithmetic."""
from calendar import monthrange
from datetime import timedelta
from zoneinfo import ZoneInfo
from prsystem.common import DomainError,timestamp


def quote(package,months):
    if type(package) is not int or package not in {20000,25000,30000} or type(months) is not int or months not in {1,3,7,12}:
        raise DomainError('INVALID_REQUEST')
    return package*months


def add_months(start,months):
    timestamp(start)
    if type(months) is not int or months<1: raise DomainError('INVALID_REQUEST')
    local=start.astimezone(ZoneInfo('Asia/Ulaanbaatar'))
    index=local.year*12+local.month-1+months
    year,month=divmod(index,12);month+=1
    return local.replace(year=year,month=month,day=min(local.day,monthrange(year,month)[1]))


def renewal_window(previous_expiry,confirmed_at,months):
    timestamp(previous_expiry);timestamp(confirmed_at)
    start=previous_expiry if confirmed_at<previous_expiry+timedelta(hours=48) else confirmed_at
    return start,add_months(start,months)
