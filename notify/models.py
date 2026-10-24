from django.db import models


class Notification(models.Model):
    """Something the club's staff should see right away in the admin site, like a new online booking.

    `data` keeps the details as they were at the time, so the message reads the
    same even after the booking changes. Each staff member's Membership remembers
    when they last looked; anything newer is unread.
    """

    class Kind(models.TextChoices):
        ONLINE_BOOKING = "online_booking", "New online booking"
        ONLINE_CANCELLED = "online_cancelled", "Online booking cancelled"
        LATE_PAYMENT = "late_payment", "Payment arrived after the hold ran out (refunded)"

    club = models.ForeignKey("clubs.Club", on_delete=models.CASCADE, related_name="notifications")
    kind = models.CharField(max_length=20, choices=Kind.choices)
    booking = models.ForeignKey("bookings.Booking", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    data = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at", "-id"]

    def __str__(self):
        return f"{self.kind} @ {self.club_id} ({self.created_at:%Y-%m-%d %H:%M})"
