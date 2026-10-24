"""Customers' prepaid balance: top-ups (packages), spending, and money put back."""

from decimal import Decimal

from django.db import transaction
from django.db.models import Sum

from bookings.services import BookingError
from clubs.models import Customer

from .models import BalanceEntry

ZERO = Decimal("0.00")
MONEY_METHODS = ("cash", "card", "transfer")


def balance_of(customer):
    if customer is None:
        return ZERO
    return BalanceEntry.objects.filter(customer=customer).aggregate(s=Sum("amount"))["s"] or ZERO


def balances_of(customer_ids):
    """{customer id: balance} for many customers in one query."""
    rows = (
        BalanceEntry.objects.filter(customer_id__in=customer_ids)
        .values("customer_id")
        .annotate(s=Sum("amount"))
    )
    return {r["customer_id"]: r["s"] for r in rows}


def top_up(customer, *, method, plan=None, paid=None, credit=None, created_by=None, note=""):
    """Money comes in; the balance grows by the plan's credit (or by what was paid)."""
    if method not in MONEY_METHODS:
        raise BookingError("Top up with cash, card or transfer.", "bad_method")
    if plan is not None:
        if plan.club_id != customer.club_id or not plan.is_active:
            raise BookingError("This package is not on sale.", "plan_unavailable")
        paid, credit = plan.price, plan.credit
    if paid is None or paid <= 0:
        raise BookingError("The amount must be more than zero.", "bad_amount")
    credit = paid if credit is None else credit
    if credit < paid:
        raise BookingError("The credit cannot be less than what was paid.", "bad_amount")
    return BalanceEntry.objects.create(
        club_id=customer.club_id,
        customer=customer,
        kind=BalanceEntry.Kind.TOPUP,
        amount=credit,
        paid=paid,
        method=method,
        plan=plan,
        note=note,
        created_by=created_by,
    )


@transaction.atomic
def spend(customer, amount, *, kind, booking=None, sale=None, created_by=None):
    """Take money from the balance. The customer row is locked so two payments cannot overdraw it."""
    if customer is None:
        raise BookingError("Only a customer with a phone number has a balance.", "no_customer")
    Customer.objects.select_for_update().get(pk=customer.pk)
    if amount <= 0:
        raise BookingError("The amount must be more than zero.", "bad_amount")
    if amount > balance_of(customer):
        raise BookingError("The customer's balance is too low.", "balance_too_low")
    return BalanceEntry.objects.create(
        club_id=customer.club_id,
        customer=customer,
        kind=kind,
        amount=-amount,
        booking=booking,
        sale=sale,
        created_by=created_by,
    )


def credit_back(customer, amount, *, booking=None, sale=None, created_by=None, note=""):
    """Put money back on the balance (a refund to balance, a removed balance payment, a voided sale)."""
    if customer is None:
        raise BookingError("Only a customer with a phone number has a balance.", "no_customer")
    return BalanceEntry.objects.create(
        club_id=customer.club_id,
        customer=customer,
        kind=BalanceEntry.Kind.REFUND,
        amount=amount,
        booking=booking,
        sale=sale,
        note=note,
        created_by=created_by,
    )
