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

    court = models.ForeignKey("clubs.Court", on_delete=models.PROTECT, related_name="bookings")
    # Always stored as timezone-aware datetimes (UTC in the database).
    start_at = models.DateTimeField()
    end_at = models.DateTimeField()
    customer_name = models.CharField(max_length=120)
    customer_phone = models.CharField(max_length=32, blank=True)
    # Price is frozen at booking time so later price changes never rewrite history.
    price = models.DecimalField(max_digits=10, decimal_places=2)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.CONFIRMED)
    # Open play: started without an end time. While open, end_at holds the court
    # until closing time and price stays 0; stopping sets the real end and price.
    is_open = models.BooleanField(default=False)
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