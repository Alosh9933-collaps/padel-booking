"""A booking's bill: court time plus buffet items, minus a discount; paid by payments, less refunds."""

from decimal import Decimal

from django.db import transaction
from django.db.models import DecimalField, F, OuterRef, Subquery, Sum, Value
from django.db.models.functions import Coalesce

from buffet.models import BookingItem
from wallet.services import credit_back, spend

from .discounts import offers, refresh_discount
from .models import Booking, Payment, Refund
from .services import BookingError

MONEY = DecimalField(max_digits=12, decimal_places=2)
ZERO = Decimal("0.00")


def with_totals(queryset):
    """Annotate bookings with items_total and paid_total in one query (no join fan-out)."""
    items = (
        BookingItem.objects.filter(booking=OuterRef("pk"))
        .values("booking")
        .annotate(s=Sum(F("unit_price") * F("quantity")))
        .values("s")
    )
    paid = (
        Payment.objects.filter(booking=OuterRef("pk"))
        .values("booking")
        .annotate(s=Sum("amount"))
        .values("s")
    )
    refunded = (
        Refund.objects.filter(booking=OuterRef("pk"))
        .values("booking")
        .annotate(s=Sum("amount"))
        .values("s")
    )
    zero = Value(ZERO, output_field=MONEY)
    return queryset.annotate(
        items_total=Coalesce(Subquery(items, output_field=MONEY), zero),
        paid_total=Coalesce(Subquery(paid, output_field=MONEY), zero),
        refunded_total=Coalesce(Subquery(refunded, output_field=MONEY), zero),
    )


def totals(booking):
    """Bill totals of one booking; uses the with_totals() annotations when present."""
    items_total = getattr(booking, "items_total", None)
    if items_total is None:
        items_total = sum((i.total for i in booking.items.all()), ZERO)
    paid_total = getattr(booking, "paid_total", None)
    if paid_total is None:
        paid_total = sum((p.amount for p in booking.payments.all()), ZERO)
    refunded_total = getattr(booking, "refunded_total", None)
    if refunded_total is None:
        refunded_total = sum((r.amount for r in booking.refunds.all()), ZERO)
    total = booking.price + items_total - booking.discount
    # Net money kept: what came in minus what was given back.
    paid_total = paid_total - refunded_total
    balance = total - paid_total
    # A cancelled booking owes nothing, so all money kept on it is refundable.
    owed = ZERO if booking.status == Booking.Status.CANCELLED else total
    refundable = max(ZERO, paid_total - owed) if not booking.is_open else ZERO
    if booking.is_open:
        state = "open"
    elif balance <= 0:
        state = "paid"
    elif paid_total > 0:
        state = "partial"
    else:
        state = "unpaid"
    return {
        "court_total": booking.price,
        "items_total": items_total,
        "discount": booking.discount,
        "total": total,
        "paid_total": paid_total,
        "refunded_total": refunded_total,
        "refundable": refundable,
        "balance": balance,
        "payment_status": state,
    }


def _ensure_billable(booking):
    if booking.status == Booking.Status.CANCELLED:
        raise BookingError("This booking is cancelled.", "booking_cancelled")


def add_item(booking, product, quantity=1, created_by=None):
    _ensure_billable(booking)
    if product.club_id != booking.court.club_id or not product.is_active:
        raise BookingError("This product is not on the menu.", "product_unavailable")
    if quantity < 1:
        raise BookingError("Quantity must be at least 1.", "bad_quantity")
    # The same product at the same price just raises the quantity.
    item = booking.items.filter(product=product, unit_price=product.price).first()
    if item:
        item.quantity += quantity
        item.save(update_fields=["quantity"])
    else:
        item = BookingItem.objects.create(
            booking=booking,
            product=product,
            name=product.name,
            unit_price=product.price,
            quantity=quantity,
            created_by=created_by,
        )
    refresh_discount(booking)
    return item


def set_item_quantity(item, quantity):
    """Quantity 0 removes the item from the bill."""
    _ensure_billable(item.booking)
    if quantity < 0:
        raise BookingError("Quantity must be at least 0.", "bad_quantity")
    booking = item.booking
    if quantity == 0:
        item.delete()
        item = None
    else:
        item.quantity = quantity
        item.save(update_fields=["quantity"])
    refresh_discount(booking)
    return item


@transaction.atomic
def add_payment(booking, amount, method, payer_name="", created_by=None):
    _ensure_billable(booking)
    if amount <= 0:
        raise BookingError("The amount must be more than zero.", "bad_amount")
    # A running open play has no final price yet, so a prepayment is fine there.
    if not booking.is_open and amount > totals(booking)["balance"]:
        raise BookingError("This is more than what is left to pay.", "overpayment")
    if method == Payment.Method.BALANCE:
        spend(booking.customer, amount, kind="payment", booking=booking, created_by=created_by)
    return Payment.objects.create(
        booking=booking, amount=amount, method=method, payer_name=payer_name, created_by=created_by
    )


@transaction.atomic
def remove_payment(payment, created_by=None):
    """Undo a payment entered by mistake; money taken from the balance goes back to it."""
    if payment.method == Payment.Method.BALANCE:
        credit_back(payment.booking.customer, payment.amount, booking=payment.booking, created_by=created_by, note="payment removed")
    payment.delete()


def _set_discount(booking, *, kind, percent=None, fixed=None, scope=Booking.DiscountScope.COURT, note=""):
    booking.discount_kind = kind
    booking.discount_percent = percent
    booking.discount_fixed = fixed
    booking.discount_scope = scope
    booking.discount_note = note
    booking.save(update_fields=["discount_kind", "discount_percent", "discount_fixed", "discount_scope", "discount_note"])
    return refresh_discount(booking)


def apply_offer(booking, kind):
    """Apply one of the loyalty offers the booking qualifies for (court time only)."""
    _ensure_billable(booking)
    offer = next((o for o in offers(booking) if o["kind"] == kind), None)
    if offer is None:
        raise BookingError("This booking does not qualify for that discount.", "offer_not_available")
    # Category offers keep the category name; visit offers keep the visit number.
    note = offer["note"] or str(offer["visit"] or "")
    return _set_discount(booking, kind=kind, percent=Decimal(offer["percent"]), note=note)


def apply_manual_discount(booking, *, percent=None, amount=None, scope=Booking.DiscountScope.TOTAL, note=""):
    """A discount typed by staff: a percent of the court time or whole bill, or a fixed amount."""
    _ensure_billable(booking)
    if (percent is None) == (amount is None):
        raise BookingError("Give either a percent or an amount.", "bad_discount")
    if percent is not None and not (0 < percent <= 100):
        raise BookingError("The percent must be between 1 and 100.", "bad_discount")
    if amount is not None and amount <= 0:
        raise BookingError("The amount must be more than zero.", "bad_discount")
    if amount is not None:
        scope = Booking.DiscountScope.TOTAL
    return _set_discount(
        booking, kind=Booking.DiscountKind.MANUAL, percent=percent, fixed=amount, scope=scope, note=note
    )


def remove_discount(booking):
    _ensure_billable(booking)
    return _set_discount(booking, kind=Booking.DiscountKind.NONE)


def add_refund(booking, amount, method, reason="", created_by=None):
    """Give money back, never more than the customer is owed back."""
    if amount <= 0:
        raise BookingError("The amount must be more than zero.", "bad_amount")
    if amount > totals(booking)["refundable"]:
        raise BookingError("This is more than the customer is owed back.", "refund_too_much")
    with transaction.atomic():
        if method == Payment.Method.BALANCE:
                    credit_back(booking.customer, amount, booking=booking, created_by=created_by, note=reason)
        return Refund.objects.create(
            booking=booking, amount=amount, method=method, reason=reason, created_by=created_by
        )
