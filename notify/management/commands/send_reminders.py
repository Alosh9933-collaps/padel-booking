"""Send Telegram reminders for games starting soon. Run it every few minutes (cron).

    python manage.py send_reminders --hours 2
"""

from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone

from bookings.models import Booking
from notify import telegram


def send_due_reminders(hours=2):
    """Remind every linked customer whose confirmed game starts within `hours`. Returns how many were sent."""
    now = timezone.now()
    due = (
        Booking.objects.filter(
            status=Booking.Status.CONFIRMED,
            hold_until__isnull=True,  # not while it waits for its prepayment
            reminder_sent_at__isnull=True,
            start_at__gt=now,
            start_at__lte=now + timedelta(hours=hours),
        )
        .exclude(customer__telegram_chat_id="")
        .exclude(customer__isnull=True)
        .select_related("court__club", "customer")
    )
    sent = 0
    for booking in due:
        club = booking.court.club
        if telegram.send(booking.customer.telegram_chat_id, telegram.text(club, "reminder", booking=telegram.describe(booking))):
            booking.reminder_sent_at = now
            booking.save(update_fields=["reminder_sent_at"])
            sent += 1
    return sent


class Command(BaseCommand):
    help = "Send Telegram reminders for games starting soon."

    def add_arguments(self, parser):
        parser.add_argument("--hours", type=int, default=2)

    def handle(self, *args, hours=2, **options):
        self.stdout.write(f"Sent {send_due_reminders(hours)} reminder(s).")
