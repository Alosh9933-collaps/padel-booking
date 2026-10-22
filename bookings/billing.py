"""A booking's bill: court time plus buffet items, minus payments received."""

from decimal import Decimal

from django.db.models import DecimalField, F, OuterRef, Subquery, Sum, Value
from django.db.models.functions import Coalesce

from buffet.models import BookingItem

from .models import Booking, Payment
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
    return queryset.annotate(
        items_total=Coalesce(Subquery(items, output_field=MONEY), Value(ZERO, output_field=MONEY)),
        paid_total=Coalesce(Subquery(paid, output_field=MONEY), Value(ZERO, output_field=MONEY)),
    )


def totals(booking):
    """Bill totals of one booking; uses the with_totals() annotations when present."""
    items_total = getattr(booking, "items_total", None)
    if items_total is None:
        items_total = sum((i.total for i in booking.items.all()), ZERO)
    paid_total = getattr(booking, "paid_total", None)
    if paid_total is None:
        paid_total = sum((p.amount for p in booking.payments.all()), ZERO)
    total = booking.price + items_total
    balance = total - paid_total
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
        "total": total,
        "paid_total": paid_total,
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
        return item
    return BookingItem.objects.create(
        booking=booking,
        product=product,
        name=product.name,
        unit_price=product.price,
        quantity=quantity,
        created_by=created_by,
    )


def set_item_quantity(item, quantity):
    """Quantity 0 removes the item from the bill."""
    _ensure_billable(item.booking)
    if quantity < 0:
        raise BookingError("Quantity must be at least 0.", "bad_quantity")
    if quantity == 0:
        item.delete()
        return None
    item.quantity = quantity
    item.save(update_fields=["quantity"])
    return item


def add_payment(booking, amount, method, payer_name="", created_by=None):
    _ensure_billable(booking)
    if amount <= 0:
        raise BookingError("The amount must be more than zero.", "bad_amount")
    # A running open play has no final price yet, so a prepayment is fine there.
    if not booking.is_open and amount > totals(booking)["balance"]:
        raise BookingError("This is more than what is left to pay.", "overpayment")
    return Payment.objects.create(
        booking=booking, amount=amount, method=method, payer_name=payer_name, created_by=created_by
    )
