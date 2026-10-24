"""Free courts held by online bookings that were not paid in time. Run it every minute (cron).

    python manage.py release_holds

The site also does this on its own whenever someone looks at the schedule or
the booking page, so the command only matters on a quiet day.
"""

from django.core.management.base import BaseCommand

from payments.services import release_expired_holds


class Command(BaseCommand):
    help = "Free courts held by online bookings whose prepayment did not come in time."

    def handle(self, *args, **options):
        release_expired_holds()
