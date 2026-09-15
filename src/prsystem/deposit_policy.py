"""Integer conservation checks shared by receipt and stay deposit projections."""
from prsystem.common import DomainError, money


def available(received, reversed=0, allocated=0, reserved=0, refunded=0):
    for value in (received,reversed,allocated,reserved,refunded):money(value)
    result=received-reversed-allocated-reserved-refunded
    if result<0:raise DomainError('DEPOSIT_BALANCE_CONFLICT')
    return result


def require_available(amount, balance):
    money(amount,positive=True)
    if amount>balance:raise DomainError('INSUFFICIENT_DEPOSIT')


def deposit_setting(amount, *, nullable=False):
    if nullable and amount is None:return
    money(amount,positive=True)
    if not 50000<=amount<=100000:raise DomainError('INVALID_DEPOSIT_AMOUNT')
