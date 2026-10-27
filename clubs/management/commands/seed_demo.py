from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import transaction

from bookings.services import create_booking
from clubs.models import Club, Court, Membership, PriceRule

DEMO_CLUB_NAME = "Demo Padel Club"
DEMO_PASSWORD = "demo-pass-123"  # local demo only, never use outside development


class Command(BaseCommand):
    help = "Create a demo club with courts, price rules, staff accounts and a few bookings."

    @transaction.atomic
    def handle(self, *args, **options):
        if Club.objects.filter(name=DEMO_CLUB_NAME).exists():
            self.stdout.write("Demo data already exists, nothing to do.")
            return

        User = get_user_model()
        club = Club.objects.create(
            name=DEMO_CLUB_NAME,
            timezone="Europe/Moscow",
            currency="RUB",
            opening_hour=8,
            closing_hour=24,
            slot_minutes=30,
        )
        court1 = Court.objects.create(club=club, name="Court 1", kind=Court.Kind.INDOOR)
        court2 = Court.objects.create(club=club, name="Court 2", kind=Court.Kind.INDOOR)
        court3 = Court.objects.create(club=club, name="Court 3", kind=Court.Kind.OUTDOOR)

        weekdays, weekend = [0, 1, 2, 3, 4], [5, 6]
        all_days = weekdays + weekend
        rules = [
            # club-wide rules
            dict(days_of_week=weekdays, start_hour=8, end_hour=17, price_per_hour=2000),
            dict(days_of_week=weekdays, start_hour=17, end_hour=24, price_per_hour=3000),
            dict(days_of_week=weekend, start_hour=8, end_hour=24, price_per_hour=3500),
            # the outdoor court is cheaper: a court rule with higher priority wins
            dict(days_of_week=all_days, start_hour=8, end_hour=24, price_per_hour=1500,
                 court=court3, priority=5),
        ]
        for rule in rules:
            PriceRule.objects.create(club=club, **rule)

        staff = {}
        for username, role in [
            ("demo_owner", Membership.Role.OWNER),
            ("demo_manager", Membership.Role.MANAGER),
            ("demo_reception", Membership.Role.RECEPTIONIST),
        ]:
            user = User.objects.create_user(username, password=DEMO_PASSWORD)
            Membership.objects.create(user=user, club=club, role=role)
            staff[username] = user

        tz = ZoneInfo(club.timezone)
        tomorrow = (datetime.now(tz) + timedelta(days=1)).date()

        def at(day, hour, minute=0):
            return datetime.combine(day, time(hour, minute), tzinfo=tz)

        reception = staff["demo_reception"]
        for court, day, start, end, name in [
            (court1, tomorrow, at(tomorrow, 18), at(tomorrow, 19, 30), "Anna"),
            (court2, tomorrow, at(tomorrow, 10), at(tomorrow, 11), "Dmitry"),
            (court1, tomorrow + timedelta(days=1), at(tomorrow + timedelta(days=1), 19),
             at(tomorrow + timedelta(days=1), 20), "Sergey"),
        ]:
            create_booking(
                court=court, start_at=start, end_at=end,
                customer_name=name, created_by=reception,
            )

        self.stdout.write(self.style.SUCCESS("Demo data created."))
        self.stdout.write(f"Logins (password for all: {DEMO_PASSWORD}):")
        self.stdout.write("  demo_owner, demo_manager, demo_reception")
