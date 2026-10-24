from django.conf import settings
from django.db import models
from django.db.models import Q
from django.utils import timezone


class Shift(models.Model):
    """One working shift at the club's cash drawer.

    Opened with the cash already in the drawer and closed with the cash
    counted at the end; the difference to what the system expects shows
    whether money is missing or extra. A club has at most one open shift.
    """

    club = models.ForeignKey("clubs.Club", on_delete=models.CASCADE, related_name="shifts")
    opened_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+"
    )
    opened_at = models.DateTimeField(default=timezone.now)
    opening_cash = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    closed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    closed_at = models.DateTimeField(null=True, blank=True)
    # Frozen when the shift closes, so later edits never rewrite a closed shift.
    expected_cash = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    counted_cash = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    note = models.TextField(blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["club"], condition=Q(closed_at__isnull=True), name="one_open_shift_per_club"
            ),
        ]
        indexes = [models.Index(fields=["club", "-opened_at"], name="shift_club_opened_idx")]

    def __str__(self):
        return f"Shift {self.opened_at:%Y-%m-%d %H:%M} at {self.club}"


class Activity(models.Model):
    """Who did what, and when: bookings, discounts, payments, refunds, sales, shifts."""

    club = models.ForeignKey("clubs.Club", on_delete=models.CASCADE, related_name="activities")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    action = models.CharField(max_length=40)
    booking = models.ForeignKey(
        "bookings.Booking", null=True, blank=True, on_delete=models.SET_NULL, related_name="activities"
    )
    sale = models.ForeignKey(
        "buffet.Sale", null=True, blank=True, on_delete=models.SET_NULL, related_name="activities"
    )
    amount = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    data = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        indexes = [models.Index(fields=["club", "-created_at"], name="activity_club_time_idx")]

    def __str__(self):
        return f"{self.action} by {self.user} at {self.created_at:%Y-%m-%d %H:%M}"
