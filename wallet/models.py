from django.conf import settings
from django.db import models
from django.db.models import Q


class TopUpPlan(models.Model):
    """A package a customer can buy: pay `price`, get `credit` on their balance (the difference is the bonus)."""

    club = models.ForeignKey("clubs.Club", on_delete=models.CASCADE, related_name="topup_plans")
    name = models.CharField(max_length=60)
    price = models.DecimalField(max_digits=10, decimal_places=2)
    credit = models.DecimalField(max_digits=10, decimal_places=2)
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["club", "name"], name="uniq_plan_name_per_club"),
            models.CheckConstraint(condition=Q(price__gt=0), name="plan_price_positive"),
            models.CheckConstraint(condition=Q(credit__gte=models.F("price")), name="plan_credit_at_least_price"),
        ]

    def __str__(self):
        return f"{self.name}: {self.price} -> {self.credit}"


class BalanceEntry(models.Model):
    """One movement of a customer's prepaid balance. The balance is the sum of all entries.

    Top-ups bring real money in (method = cash/card/transfer); payments and
    sales paid from the balance take it out; refunds to the balance put it back.
    """

    class Kind(models.TextChoices):
        TOPUP = "topup", "Top-up"
        PAYMENT = "payment", "Booking payment"
        SALE = "sale", "Buffet sale"
        REFUND = "refund", "Refund"
        ADJUSTMENT = "adjustment", "Adjustment"

    club = models.ForeignKey("clubs.Club", on_delete=models.CASCADE, related_name="balance_entries")
    customer = models.ForeignKey("clubs.Customer", on_delete=models.CASCADE, related_name="balance_entries")
    kind = models.CharField(max_length=10, choices=Kind.choices)
    amount = models.DecimalField(max_digits=10, decimal_places=2, help_text="Positive adds, negative takes away")
    # For top-ups: the money actually paid and how.
    paid = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    method = models.CharField(max_length=10, blank=True)
    plan = models.ForeignKey(TopUpPlan, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    booking = models.ForeignKey("bookings.Booking", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    sale = models.ForeignKey("buffet.Sale", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    note = models.CharField(max_length=200, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [models.Index(fields=["customer", "-created_at"], name="balance_customer_time_idx")]
        constraints = [models.CheckConstraint(condition=~Q(amount=0), name="balance_entry_not_zero")]

    def __str__(self):
        return f"{self.kind} {self.amount} for {self.customer}"
