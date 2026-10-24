import uuid

from django.db import models
from django.db.models import Q


class OnlinePayment(models.Model):
    """A prepayment made on the online booking page, through a payment provider.

    The provider (YooKassa, or the demo page while testing) handles the money and
    this row mirrors what it says. The bill only gets the money, as a Payment with
    the "online" method, once the provider reports success (see services.sync).
    """

    class Status(models.TextChoices):
        PENDING = "pending", "Waiting for the customer"
        SUCCEEDED = "succeeded", "Paid"
        CANCELED = "canceled", "Not paid"

    # Random, because the demo payment page is addressed by it.
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    booking = models.ForeignKey("bookings.Booking", on_delete=models.CASCADE, related_name="online_payments")
    provider = models.CharField(max_length=20)
    provider_id = models.CharField(max_length=64, blank=True, db_index=True)
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    refunded = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING)
    # Where the customer pays: the provider's page, or /pay/demo/<id>.
    confirmation_url = models.CharField(max_length=500, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    paid_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=Q(amount__gt=0), name="online_payment_amount_positive"),
        ]

    def __str__(self):
        return f"{self.amount} via {self.provider} for booking {self.booking_id} ({self.status})"
