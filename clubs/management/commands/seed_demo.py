"""Fill the database with a realistic demo club to try every feature.

    python manage.py seed_demo            # adds the demo club once
    python manage.py seed_demo --reset    # deletes it first and rebuilds it

Logins (all with the password below): demo_owner, demo_manager, demo_desk.
"""

import uuid
from datetime import datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from bookings.billing import add_item, add_payment, totals
from bookings.models import Booking, Payment
from bookings.services import BookingError, create_booking, create_weekly, mark_no_show
from wallet.models import TopUpPlan
from wallet.services import top_up
from buffet.models import Product
from clubs.models import Club, Court, Customer, CustomerCategory, DiscountSettings, Membership, PriceRule

CLUB_NAME = "Padel Arena (demo)"
PASSWORD = "padel-demo-2026"
TZ = "Europe/Moscow"

PLAYERS = [
    ("Ivan Petrov", "+7 900 111-22-33"),
    ("Maria Sokolova", "+7 900 222-33-44"),
    ("Ali Hassan", "+7 900 333-44-55"),
    ("Olga Smirnova", "+7 900 444-55-66"),
    ("Dmitry Volkov", "+7 900 555-66-77"),
    ("Sara Khalil", "+7 900 666-77-88"),
    ("Anna Kuznetsova", "+7 900 777-88-99"),
    ("Omar Saleh", "+7 900 888-99-00"),
]

MENU = [
    ("Water 0.5 L", "Drinks", "100"),
    ("Isotonic", "Drinks", "250"),
    ("Coffee", "Drinks", "200"),
    ("Fresh juice", "Drinks", "350"),
    ("Protein bar", "Snacks", "250"),
    ("Banana", "Snacks", "80"),
    ("Ball tube (3)", "Equipment", "900"),
    ("Racket rental", "Equipment", "500"),
]

# (court index, start hour, start minute, minutes) for a typical day
DAY_PLAN = [
    (0, 9, 0, 90),
    (1, 10, 30, 60),
    (0, 12, 0, 120),
    (2, 17, 0, 90),
    (0, 18, 30, 90),
    (1, 19, 0, 120),
    (2, 20, 30, 60),
]


class Command(BaseCommand):
    help = "Create a demo club with courts, prices, buffet, staff, customers and bookings."

    def add_arguments(self, parser):
        parser.add_argument("--reset", action="store_true", help="Delete the demo club first.")

    @transaction.atomic
    def handle(self, *args, reset=False, **options):
        existing = Club.objects.filter(name=CLUB_NAME).first()
        if existing and not reset:
            self.stdout.write("The demo club already exists. Use --reset to rebuild it.")
            return
        if existing:
            Payment.objects.filter(booking__court__club=existing).delete()
            Booking.objects.filter(court__club=existing).delete()
            existing.delete()

        tz = ZoneInfo(TZ)
        club = Club.objects.create(
            name=CLUB_NAME,
            timezone=TZ,
            currency="RUB",
            opening_hour=8,
            closing_hour=24,
            slot_minutes=30,
            slug="padel-arena-demo",
            online_booking_enabled=True,
        )
        courts = [
            Court.objects.create(club=club, name="Court 1", kind=Court.Kind.INDOOR),
            Court.objects.create(club=club, name="Court 2", kind=Court.Kind.INDOOR),
            Court.objects.create(club=club, name="Court 3", kind=Court.Kind.OUTDOOR),
        ]
        weekdays, weekend = [0, 1, 2, 3, 4], [5, 6]
        PriceRule.objects.create(club=club, days_of_week=weekdays, start_hour=8, end_hour=17, price_per_hour=Decimal("2000"))
        PriceRule.objects.create(club=club, days_of_week=weekdays, start_hour=17, end_hour=24, price_per_hour=Decimal("3200"))
        PriceRule.objects.create(club=club, days_of_week=weekend, start_hour=8, end_hour=24, price_per_hour=Decimal("3600"))
        products = {
            name: Product.objects.create(club=club, name=name, category=category, price=Decimal(price))
            for name, category, price in MENU
        }

        User = get_user_model()
        for username, role in (
            ("demo_owner", Membership.Role.OWNER),
            ("demo_manager", Membership.Role.MANAGER),
            ("demo_desk", Membership.Role.RECEPTIONIST),
        ):
            user, _ = User.objects.get_or_create(username=username, defaults={"first_name": username[5:].title()})
            user.set_password(PASSWORD)
            user.save()
            Membership.objects.get_or_create(user=user, club=club, defaults={"role": role})

        now = timezone.now()
        today = now.astimezone(tz).date()
        made = 0
        for offset in range(-55, 3):
            day = today + timedelta(days=offset)
            for i, (court_index, hour, minute, minutes) in enumerate(DAY_PLAN):
                # Skip some slots so days differ.
                if (offset + i) % 4 == 3:
                    continue
                name, phone = PLAYERS[(offset * 3 + i) % len(PLAYERS)]
                start = datetime.combine(day, time(hour, minute), tzinfo=tz)
                try:
                    booking = create_booking(
                        court=courts[court_index],
                        start_at=start,
                        end_at=start + timedelta(minutes=minutes),
                        customer_name=name,
                        customer_phone=phone,
                    )
                except BookingError:
                    continue
                made += 1
                self._bill(booking, products, seed=offset * 7 + i, past=booking.end_at <= now)

        # A regular Tuesday group, eight weeks from the coming Tuesday.
        tuesday = today + timedelta(days=(1 - today.weekday()) % 7)
        start = datetime.combine(tuesday, time(21, 0), tzinfo=tz)
        create_weekly(
            court=courts[1],
            start_at=start,
            end_at=start + timedelta(minutes=90),
            weeks=8,
            customer_name="Tuesday group",
            customer_phone="+7 900 999-00-11",
        )

        # Loyalty: first visit -25%, every 10th visit free, two categories.
        DiscountSettings.objects.create(
            club=club, first_visit_enabled=True, first_visit_percent=25, nth_visit_enabled=True, nth_visit_every=10, nth_visit_percent=100
        )
        regular = CustomerCategory.objects.create(club=club, name="Regular", color="#2f9a6a", discount_percent=10)
        coach = CustomerCategory.objects.create(club=club, name="Coach", color="#7c4dcc", discount_percent=50)
        Customer.objects.filter(club=club, name__in=["Ivan Petrov", "Ali Hassan", "Anna Kuznetsova"]).update(category=regular)
        Customer.objects.filter(club=club, name="Omar Saleh").update(category=coach)

        # Packages, and a few customers with a prepaid balance.
        silver = TopUpPlan.objects.create(club=club, name="Silver", price=Decimal("5000"), credit=Decimal("5500"))
        gold = TopUpPlan.objects.create(club=club, name="Gold", price=Decimal("10000"), credit=Decimal("11500"))
        TopUpPlan.objects.create(club=club, name="Platinum", price=Decimal("20000"), credit=Decimal("24000"))
        for name, plan in (("Ivan Petrov", gold), ("Sara Khalil", silver), ("Olga Smirnova", silver)):
            customer = Customer.objects.filter(club=club, name=name).first()
            if customer:
                top_up(customer, plan=plan, method="card")

        # Two bookings made online by customers.
        tomorrow = today + timedelta(days=1)
        for hour, (name, phone) in ((11, ("Elena Morozova", "+7 901 234-56-78")), (15, ("Karim Nassar", "+7 902 345-67-89"))):
            start = datetime.combine(tomorrow, time(hour, 0), tzinfo=tz)
            try:
                booking = create_booking(
                    court=courts[2], start_at=start, end_at=start + timedelta(minutes=90), customer_name=name, customer_phone=phone
                )
            except BookingError:
                continue
            booking.source = Booking.Source.ONLINE
            booking.public_token = uuid.uuid4()
            booking.save(update_fields=["source", "public_token"])

        self.stdout.write(self.style.SUCCESS(f"Demo club ready with {made} bookings."))
        self.stdout.write("Public booking page: /book/padel-arena-demo")
        self.stdout.write(f"Sign in as demo_owner, demo_manager or demo_desk with the password {PASSWORD}")

    def _bill(self, booking, products, seed, past):
        """Buffet items and payments that look like a real day: most paid, some not."""
        names = list(products)
        for k in range(seed % 3):
            add_item(booking, products[names[(seed + k * 3) % len(names)]], quantity=1 + (seed + k) % 3)
        if not past:
            return
        if seed % 9 == 4:
            mark_no_show(booking)
            return
        due = totals(booking)["balance"]
        when = booking.end_at
        if seed % 5 == 0:
            return  # left unpaid
        if seed % 5 == 1:
            half = (due / 2).quantize(Decimal("1"))
            payments = [add_payment(booking, half, "cash"), add_payment(booking, due - half, "card")]
        elif seed % 5 == 2:
            payments = [add_payment(booking, (due / 2).quantize(Decimal("1")), "transfer")]
        else:
            payments = [add_payment(booking, due, "card" if seed % 2 else "cash")]
        Payment.objects.filter(pk__in=[p.pk for p in payments]).update(created_at=when)
