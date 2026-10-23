"""Discounts on a booking's bill.

A bill carries at most one discount: a percent of the court time or of the
whole bill, or a fixed amount off the whole bill. The money value is stored
in Booking.discount so reports can sum it, and refresh_discount() keeps it in
step whenever the price or the buffet items change.

Loyalty rules (first visit, every Nth visit, customer category) never apply
themselves: offers() lists what a booking qualifies for, and staff choose.
"""

from decimal import ROUND_HALF_UP, Decimal

from django.db.models import F, Sum

from buffet.models import BookingItem
from clubs.models import DiscountSettings

from .models import Booking

CENT = Decimal("0.01")
ZERO = Decimal("0.00")


def _items_total(booking):
    total = BookingItem.objects.filter(booking=booking).aggregate(s=Sum(F("unit_price") * F("quantity")))["s"]
    return total or ZERO


def discount_amount(booking):
    """Money taken off this bill by its discount, never more than the bill."""
    if not booking.discount_kind:
        return ZERO
    if booking.discount_fixed is not None:
        return min(booking.discount_fixed, booking.price + _items_total(booking)).quantize(CENT)
    if booking.discount_scope == Booking.DiscountScope.TOTAL:
        base = booking.price + _items_total(booking)
    else:
        base = booking.price
    percent = booking.discount_percent or ZERO
    return (base * percent / 100).quantize(CENT, rounding=ROUND_HALF_UP)


def refresh_discount(booking):
    """Recalculate the stored discount after the price or the items changed."""
    amount = discount_amount(booking)
    if amount != booking.discount:
        booking.discount = amount
        booking.save(update_fields=["discount"])
    return booking


def visit_number(booking):
    """Which visit of its customer this booking is (1 = first), counting confirmed bookings by start time."""
    if booking.customer_id is None:
        return None
    earlier = (
        Booking.objects.filter(
            customer_id=booking.customer_id,
            status=Booking.Status.CONFIRMED,
            start_at__lt=booking.start_at,
        )
        .exclude(pk=booking.pk)
        .count()
    )
    return earlier + 1


def offers(booking):
    """Loyalty discounts this booking qualifies for, best first. All are on court time."""
    if booking.status != Booking.Status.CONFIRMED or booking.customer_id is None:
        return []
    rules = DiscountSettings.objects.filter(club_id=booking.court.club_id).first()
    visit = visit_number(booking)
    found = []
    if rules and rules.first_visit_enabled and rules.first_visit_percent and visit == 1:
        found.append({"kind": Booking.DiscountKind.FIRST_VISIT, "percent": rules.first_visit_percent, "visit": visit, "note": ""})
    if rules and rules.nth_visit_enabled and rules.nth_visit_percent and visit % rules.nth_visit_every == 0:
        found.append({"kind": Booking.DiscountKind.NTH_VISIT, "percent": rules.nth_visit_percent, "visit": visit, "note": ""})
    category = booking.customer.category
    if category and category.discount_percent:
        found.append({"kind": Booking.DiscountKind.CATEGORY, "percent": category.discount_percent, "visit": visit, "note": category.name})
    for offer in found:
        offer["amount"] = (booking.price * offer["percent"] / 100).quantize(CENT, rounding=ROUND_HALF_UP)
    return sorted(found, key=lambda o: -o["percent"])
