from django.conf import settings
from django.core.validators import MinValueValidator
from django.db import models
from django.db.models import Q


class Product(models.Model):
    """Something the buffet sells: a drink, a snack, a ball tube, a racket rental."""

    club = models.ForeignKey("clubs.Club", on_delete=models.CASCADE, related_name="products")
    name = models.CharField(max_length=80)
    category = models.CharField(max_length=40, blank=True)
    price = models.DecimalField(max_digits=10, decimal_places=2)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["club", "name"], name="uniq_product_name_per_club"),
            models.CheckConstraint(condition=Q(price__gte=0), name="product_price_not_negative"),
        ]

    def __str__(self):
        return f"{self.name} ({self.price})"


class BookingItem(models.Model):
    """A buffet product added to a booking's bill.

    Name and unit price are copied from the product, so a later price change
    or a deleted product never rewrites an old bill.
    """

    booking = models.ForeignKey("bookings.Booking", on_delete=models.CASCADE, related_name="items")
    product = models.ForeignKey(
        Product, null=True, blank=True, on_delete=models.SET_NULL, related_name="sold"
    )
    name = models.CharField(max_length=80)
    unit_price = models.DecimalField(max_digits=10, decimal_places=2)
    quantity = models.PositiveSmallIntegerField(default=1, validators=[MinValueValidator(1)])
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=Q(quantity__gte=1), name="item_quantity_positive"),
        ]

    @property
    def total(self):
        return self.unit_price * self.quantity

    def __str__(self):
        return f"{self.quantity} x {self.name}"


class Sale(models.Model):
    """A buffet sale paid at the counter, without a court booking."""

    club = models.ForeignKey("clubs.Club", on_delete=models.CASCADE, related_name="sales")
    customer = models.ForeignKey(
        "clubs.Customer", null=True, blank=True, on_delete=models.SET_NULL, related_name="sales"
    )
    customer_name = models.CharField(max_length=120, blank=True)
    method = models.CharField(
        max_length=10,
        choices=[("cash", "Cash"), ("card", "Card"), ("transfer", "Transfer"), ("balance", "Balance")],
    )
    total = models.DecimalField(max_digits=10, decimal_places=2)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    # A voided sale gave the money back; it stays on record but counts for nothing.
    voided_at = models.DateTimeField(null=True, blank=True)
    voided_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    void_reason = models.CharField(max_length=200, blank=True)

    class Meta:
        indexes = [models.Index(fields=["club", "-created_at"], name="sale_club_time_idx")]

    def __str__(self):
        return f"Sale {self.pk}: {self.total}"


class SaleItem(models.Model):
    sale = models.ForeignKey(Sale, on_delete=models.CASCADE, related_name="items")
    product = models.ForeignKey(Product, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    name = models.CharField(max_length=80)
    unit_price = models.DecimalField(max_digits=10, decimal_places=2)
    quantity = models.PositiveSmallIntegerField(default=1, validators=[MinValueValidator(1)])

    @property
    def total(self):
        return self.unit_price * self.quantity

    def __str__(self):
        return f"{self.quantity} x {self.name}"

