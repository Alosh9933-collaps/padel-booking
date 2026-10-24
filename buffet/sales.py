"""Counter sales: buffet products sold and paid on the spot, without a booking."""

from collections import Counter
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from bookings.services import BookingError, resolve_customer

from .models import Sale, SaleItem


@transaction.atomic
def create_sale(*, club, lines, method, customer_name="", customer_phone="", created_by=None):
    """lines: (product, quantity) pairs. The same product twice is merged."""
    quantities = Counter()
    products = {}
    for product, quantity in lines:
        if product.club_id != club.pk or not product.is_active:
            raise BookingError("This product is not on the menu.", "product_unavailable")
        if quantity < 1:
            raise BookingError("Quantity must be at least 1.", "bad_quantity")
        quantities[product.pk] += quantity
        products[product.pk] = product
    if not quantities:
        raise BookingError("Add at least one product.", "empty_sale")

    total = sum((products[pk].price * qty for pk, qty in quantities.items()), Decimal("0"))
    sale = Sale.objects.create(
        club=club,
        customer=resolve_customer(club, customer_name, customer_phone),
        customer_name=customer_name,
        method=method,
        total=total,
        created_by=created_by,
    )
    SaleItem.objects.bulk_create(
        SaleItem(sale=sale, product=products[pk], name=products[pk].name, unit_price=products[pk].price, quantity=qty)
        for pk, qty in quantities.items()
    )
    return sale


def void_sale(sale, *, user=None, reason=""):
    """The money was given back: the sale stays on record but counts for nothing."""
    if sale.voided_at is not None:
        raise BookingError("This sale is already voided.", "sale_voided")
    sale.voided_at = timezone.now()
    sale.voided_by = user
    sale.void_reason = reason
    sale.save(update_fields=["voided_at", "voided_by", "void_reason"])
    return sale
