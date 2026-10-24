"""The cash drawer: shifts, expected cash, and the activity log."""

from decimal import Decimal

from django.db import IntegrityError, transaction
from django.db.models import Sum
from django.utils import timezone

from bookings.models import Payment, Refund
from bookings.services import BookingError
from buffet.models import Sale

from .models import Activity, Shift

ZERO = Decimal("0.00")
CASH = Payment.Method.CASH


def record(club, user, action, *, booking=None, sale=None, amount=None, **data):
    """Write one line to the activity log. Values in data must be JSON-friendly."""
    return Activity.objects.create(
        club=club,
        user=user if user is not None and user.is_authenticated else None,
        action=action,
        booking=booking,
        sale=sale,
        amount=amount,
        data={k: (str(v) if isinstance(v, Decimal) else v) for k, v in data.items()},
    )


def current_shift(club):
    return Shift.objects.filter(club=club, closed_at__isnull=True).first()


def cash_summary(club, start, end, opening=ZERO):
    """Cash that went through the drawer between start and end."""

    def total(qs, field):
        return qs.aggregate(s=Sum(field))["s"] or ZERO

    # Inclusive end: money taken this very second still belongs to the open shift.
    window = {"created_at__gte": start, "created_at__lte": end}
    bookings_in = total(Payment.objects.filter(booking__court__club=club, method=CASH, **window), "amount")
    sales_in = total(Sale.objects.filter(club=club, method=CASH, voided_at__isnull=True, **window), "total")
    refunds_out = total(Refund.objects.filter(booking__court__club=club, method=CASH, **window), "amount")
    return {
        "opening_cash": opening,
        "cash_bookings": bookings_in,
        "cash_sales": sales_in,
        "cash_refunds": refunds_out,
        "expected_cash": opening + bookings_in + sales_in - refunds_out,
    }


def shift_summary(shift):
    end = shift.closed_at or timezone.now()
    summary = cash_summary(shift.club, shift.opened_at, end, opening=shift.opening_cash)
    if shift.closed_at is not None:
        summary["expected_cash"] = shift.expected_cash
    return summary


def open_shift(club, user, opening_cash):
    if opening_cash < 0:
        raise BookingError("The amount cannot be negative.", "bad_amount")
    try:
        with transaction.atomic():
            return Shift.objects.create(
                club=club, opened_by=user, opened_at=timezone.now(), opening_cash=opening_cash
            )
    except IntegrityError as exc:
        raise BookingError("A shift is already open at this club.", "shift_already_open") from exc


def close_shift(shift, user, counted_cash, note=""):
    if shift.closed_at is not None:
        raise BookingError("This shift is already closed.", "shift_closed")
    if counted_cash < 0:
        raise BookingError("The amount cannot be negative.", "bad_amount")
    now = timezone.now()
    shift.expected_cash = cash_summary(shift.club, shift.opened_at, now, opening=shift.opening_cash)["expected_cash"]
    shift.counted_cash = counted_cash
    shift.closed_at = now
    shift.closed_by = user
    shift.note = note
    shift.save(update_fields=["expected_cash", "counted_cash", "closed_at", "closed_by", "note"])
    return shift
