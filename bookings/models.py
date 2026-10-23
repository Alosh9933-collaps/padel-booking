from django.conf import settings
from django.contrib.postgres.constraints import ExclusionConstraint
from django.contrib.postgres.fields import DateTimeRangeField, RangeBoundary, RangeOperators
from django.db import models
from django.db.models import F, Func, Q


class TsTzRange(Func):
    function = "TSTZRANGE"
    output_field = DateTimeRangeField()


class Booking(models.Model):
    class Status(models.TextChoices):
        CONFIRMED = "confirmed", "Confirmed"
        CANCELLED = "cancelled", "Cancelled"
        NO_SHOW = "no_show", "No-show"

    court = models.ForeignKey("clubs.Court", on_delete=models.PROTECT, related_name="bookings")
    # Always stored as timezone-aware datetimes (UTC in the database).
    start_at = models.DateTimeField()
    end_at = models.DateTimeField()
    customer = models.ForeignKey(
        "clubs.Customer", null=True, blank=True, on_delete=models.SET_NULL, related_name="bookings"
    )
    # Name and phone as given at booking time; the Customer record may change later.
    customer_name = models.CharField(max_length=120)
    customer_phone = models.CharField(max_length=32, blank=True)
    # Price is frozen at booking time so later price changes never rewrite history.
    price = models.DecimalField(max_digits=10, decimal_places=2)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.CONFIRMED)
    # Open play: started without an end time. While open, end_at holds the court
    # until closing time and price stays 0; stopping sets the real end and price.
    is_open = models.BooleanField(default=False)
    # Bookings made together as a weekly series share this id.
    series = models.UUIDField(null=True, blank=True, db_index=True)

    # One discount per bill. Either a percent of a scope or a fixed amount off
    # the whole bill; `discount` holds the resulting money and is recalculated
    # whenever the bill changes (see bookings.discounts).
    class DiscountKind(models.TextChoices):
        NONE = "", "None"
        FIRST_VISIT = "first_visit", "First visit"
        NTH_VISIT = "nth_visit", "Loyalty visit"
        CATEGORY = "category", "Customer category"
        MANUAL = "manual", "Manual"

    class DiscountScope(models.TextChoices):
        COURT = "court", "Court time"
        TOTAL = "total", "Whole bill"

    discount_kind = models.CharField(max_length=12, choices=DiscountKind.choices, default="", blank=True)
    discount_percent = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    discount_fixed = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    discount_scope = models.CharField(
        max_length=5, choices=DiscountScope.choices, default=DiscountScope.COURT
    )
    discount_note = models.CharField(max_length=120, blank=True)
    discount = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    cancelled_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [models.Index(fields=["court", "start_at"], name="booking_court_start_idx")]
        constraints = [
            models.CheckConstraint(
                condition=Q(end_at__gt=F("start_at")), name="booking_end_after_start"
            ),
            # The database itself refuses two confirmed bookings on the same court
            # whose time ranges overlap. Ranges are half-open [start, end), so
            # 10:00-11:00 followed by 11:00-12:00 is allowed.
            ExclusionConstraint(
                name="booking_no_overlap",
                expressions=[
                    (TsTzRange("start_at", "end_at", RangeBoundary()), RangeOperators.OVERLAPS),
                    ("court", RangeOperators.EQUAL),
                ],
                condition=Q(status="confirmed"),
            ),
        ]

    def __str__(self):
        return f"{self.court} {self.start_at:%Y-%m-%d %H:%M} ({self.status})"


class Payment(models.Model):
    """Money received for a booking. Players often split, so a booking can have several."""

    class Method(models.TextChoices):
        CASH = "cash", "Cash"
        CARD = "card", "Card"
        TRANSFER = "transfer", "Transfer"

    booking = models.ForeignKey(Booking, on_delete=models.CASCADE, related_name="payments")
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    method = models.CharField(max_length=10, choices=Method.choices, default=Method.CASH)
    payer_name = models.CharField(max_length=120, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(condition=Q(amount__gt=0), name="payment_amount_positive"),
        ]

    def __str__(self):
        return f"{self.amount} {self.method} for booking {self.booking_id}"

