"""Fill the database with a realistic demo club to try every feature.

    python manage.py seed_demo            # adds the demo club once
    python manage.py seed_demo --reset    # deletes it first and rebuilds it

The club opened about five months ago and has been getting busier since: quiet
middays, full evenings and weekends. The data is random but seeded, so every
rebuild looks the same (relative to today).

Logins (all with the password below): demo_owner, demo_manager, demo_desk.
"""

import random
import uuid
from datetime import datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from bookings.billing import add_item, add_payment, apply_offer, totals
from bookings.discounts import offers
from bookings.models import Booking, Payment
from bookings.services import BookingError, cancel_booking, create_booking, create_weekly, mark_no_show, start_open_session
from buffet.models import Product, Sale
from buffet.sales import create_sale
from clubs.models import Club, Court, Customer, CustomerCategory, DiscountSettings, Membership, PriceRule
from wallet.models import BalanceEntry, TopUpPlan
from wallet.services import balance_of, top_up

CLUB_NAME = "Padel Arena (demo)"
PASSWORD = "padel-demo-2026"
TZ = "Europe/Moscow"
DAYS_BACK = 150

# (name, phone, how often they book: 3 = most weeks, 1 = now and then)
PLAYERS = [
    ("Ivan Petrov", "+7 900 111-22-33", 3),
    ("Ali Hassan", "+7 900 333-44-55", 3),
    ("Anna Kuznetsova", "+7 900 777-88-99", 3),
    ("Omar Saleh", "+7 900 888-99-00", 3),
    ("Dmitry Volkov", "+7 900 555-66-77", 2),
    ("Maria Sokolova", "+7 900 222-33-44", 2),
    ("Olga Smirnova", "+7 900 444-55-66", 2),
    ("Sara Khalil", "+7 900 666-77-88", 2),
    ("Sergey Orlov", "+7 903 120-45-67", 2),
    ("Youssef Haddad", "+7 903 230-56-78", 2),
    ("Natalia Popova", "+7 903 340-67-89", 1),
    ("Alexei Morozov", "+7 903 450-78-90", 1),
    ("Layla Darwish", "+7 903 560-89-01", 1),
    ("Mikhail Lebedev", "+7 903 670-90-12", 1),
    ("Ekaterina Belova", "+7 903 780-01-23", 1),
    ("Hassan Nasser", "+7 903 890-12-34", 1),
    ("Pavel Kozlov", "+7 904 210-33-45", 1),
    ("Irina Fedorova", "+7 904 320-44-56", 1),
    ("Nikolai Pavlov", "+7 904 430-55-67", 1),
    ("Rania Aziz", "+7 904 540-66-78", 1),
]

# Everyone else is made up from these: men's and women's Russian names, and Arab names.
MEN = ["Artem", "Kirill", "Viktor", "Maxim", "Roman", "Igor", "Denis", "Andrei", "Georgy", "Boris", "Fedor", "Anton", "Egor", "Ilya", "Timur", "Gleb", "Oleg"]
WOMEN = ["Polina", "Yulia", "Ksenia", "Alina", "Svetlana", "Vera", "Oksana", "Daria", "Marina", "Sofia", "Anastasia", "Viktoria"]
SURNAMES = ["Zaitsev", "Nikitin", "Egorov", "Kovalev", "Belov", "Frolov", "Titov", "Sidorov", "Medvedev", "Makarov", "Krylov", "Kuzmin", "Sorokin", "Bogdanov", "Zhukov", "Filippov"]
ARAB_FIRST = ["Rami", "Nour", "Tarek", "Mona", "Rana", "Zaid", "Amira", "Samir", "Lina", "Fadi", "Hiba", "Bilal", "Dina"]
ARAB_LAST = ["Mansour", "Saad", "Aziz", "Khoury", "Farah", "Hamdan", "Said", "Haddad", "Darwish", "Issa"]

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

# (days before today, customer, package, method)
TOPUPS = [
    (-118, "Ivan Petrov", "Gold", "card"),
    (-96, "Ali Hassan", "Silver", "cash"),
    (-74, "Sara Khalil", "Silver", "card"),
    (-61, "Ivan Petrov", "Gold", "card"),
    (-47, "Olga Smirnova", "Silver", "transfer"),
    (-38, "Omar Saleh", "Platinum", "card"),
    (-26, "Anna Kuznetsova", "Gold", "card"),
    (-15, "Sara Khalil", "Silver", "cash"),
    (-9, "Youssef Haddad", "Silver", "card"),
    (-4, "Ivan Petrov", "Gold", "card"),
    (-1, "Maria Sokolova", "Gold", "transfer"),
]


def demand(hour, weekend):
    """How likely a free court gets booked at this hour (before the club's growth)."""
    if hour < 12:
        return 0.35 if weekend else 0.22
    if hour < 17:
        return 0.45 if weekend else 0.12
    if hour < 22:
        return 0.85 if weekend else 0.8
    return 0.3


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
            BalanceEntry.objects.filter(club=existing).delete()
            Payment.objects.filter(booking__court__club=existing).delete()
            Booking.objects.filter(court__club=existing).delete()
            Sale.objects.filter(club=existing).delete()
            existing.delete()

        self.rng = random.Random(2026)
        self.crowd = self._crowd(DAYS_BACK + 10)
        self.tz = tz = ZoneInfo(TZ)
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
        self.products = [
            Product.objects.create(club=club, name=name, category=category, price=Decimal(price))
            for name, category, price in MENU
        ]

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

        # Loyalty: first visit -25%, every 10th visit free, two categories.
        DiscountSettings.objects.create(
            club=club, first_visit_enabled=True, first_visit_percent=25, nth_visit_enabled=True, nth_visit_every=10, nth_visit_percent=100
        )
        regular = CustomerCategory.objects.create(club=club, name="Regular", color="#2f9a6a", discount_percent=10)
        coach = CustomerCategory.objects.create(club=club, name="Coach", color="#7c4dcc", discount_percent=50)
        customers = {name: Customer.objects.create(club=club, name=name, phone=phone) for name, phone, _ in PLAYERS}
        for name in ("Ivan Petrov", "Ali Hassan", "Anna Kuznetsova"):
            customers[name].category = regular
            customers[name].save(update_fields=["category"])
        customers["Omar Saleh"].category = coach
        customers["Omar Saleh"].save(update_fields=["category"])

        plans = {
            name: TopUpPlan.objects.create(club=club, name=name, price=Decimal(price), credit=Decimal(credit))
            for name, price, credit in (("Silver", "5000", "5500"), ("Gold", "10000", "11500"), ("Platinum", "20000", "24000"))
        }

        now = timezone.now()
        today = now.astimezone(tz).date()

        # Bookings made ahead: a regular Tuesday group and two booked online.
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
        tomorrow = today + timedelta(days=1)
        for hour, (name, phone) in ((11, ("Elena Morozova", "+7 901 234-56-78")), (15, ("Karim Nassar", "+7 902 345-67-89"))):
            start = datetime.combine(tomorrow, time(hour, 0), tzinfo=tz)
            booking = create_booking(
                court=courts[2], start_at=start, end_at=start + timedelta(minutes=90), customer_name=name, customer_phone=phone
            )
            booking.source = Booking.Source.ONLINE
            booking.public_token = uuid.uuid4()
            booking.save(update_fields=["source", "public_token"])

        topups = {offset: (name, plan, method) for offset, name, plan, method in TOPUPS}
        open_now = club.opening_hour <= now.astimezone(tz).hour < club.closing_hour - 1
        made = 0
        for offset in range(-DAYS_BACK, 3):
            day = today + timedelta(days=offset)
            if offset in topups:
                name, plan, method = topups[offset]
                entry = top_up(customers[name], plan=plans[plan], method=method)
                BalanceEntry.objects.filter(pk=entry.pk).update(created_at=self._at(day, 10, 30))
            # The club fills up as word gets around.
            growth = 0.45 + 0.55 * (DAYS_BACK + min(offset, 0)) / DAYS_BACK
            for court in courts:
                # While the club is open, leave Court 3 free from now on for a game of open play.
                until = now if open_now and day == today and court is courts[2] else None
                made += self._fill_day(court, day, growth, DAYS_BACK + offset, now, today, until)
            if offset <= 0:
                self._counter_sales(club, day, growth, now)

        if open_now:
            start_open_session(court=courts[2], customer_name="Marat Ivanov", customer_phone="+7 905 777-12-34")

        # A customer joined the day they first booked.
        for customer in Customer.objects.filter(club=club):
            first = Booking.objects.filter(customer=customer).order_by("start_at").values_list("start_at", flat=True).first()
            if first and first < now:
                joined = first - timedelta(hours=self.rng.randint(2, 72))
                Customer.objects.filter(pk=customer.pk).update(created_at=joined)

        self.stdout.write(self.style.SUCCESS(f"Demo club ready with {made} bookings."))
        self.stdout.write("Public booking page: /book/padel-arena-demo")
        self.stdout.write(f"Sign in as demo_owner, demo_manager or demo_desk with the password {PASSWORD}")

    def _at(self, day, hour, minute):
        return datetime.combine(day, time(hour, minute), tzinfo=self.tz)

    def _crowd(self, size):
        """(name, phone, weight) for the club's wider circle of players, made up but stable."""
        rng = random.Random(7)
        names = {name for name, _, _ in PLAYERS}
        crowd = []
        while len(crowd) < size:
            kind = rng.random()
            if kind < 0.4:
                name = f"{rng.choice(MEN)} {rng.choice(SURNAMES)}"
            elif kind < 0.7:
                name = f"{rng.choice(WOMEN)} {rng.choice(SURNAMES)}a"
            else:
                name = f"{rng.choice(ARAB_FIRST)} {rng.choice(ARAB_LAST)}"
            if name in names:
                continue
            names.add(name)
            phone = f"+7 9{rng.randint(10, 99)} {rng.randint(100, 999)}-{rng.randint(10, 99)}-{rng.randint(10, 99)}"
            crowd.append((name, phone, rng.choice([1, 1, 1, 2, 3])))
        return crowd

    def _player(self, days_open):
        """A third of the bookings come from the regulars; new faces keep arriving as the club grows."""
        if self.rng.random() < 0.35:
            pool = PLAYERS[: 6 + days_open // 7]
        else:
            pool = self.crowd[: 10 + days_open]
        name, phone, _ = self.rng.choices(pool, weights=[w for _, _, w in pool])[0]
        return name, phone

    def _fill_day(self, court, day, growth, days_open, now, today, until=None):
        """Walk through the day and book the court the way demand would."""
        rng = self.rng
        weekend = day.weekday() >= 5
        close = self._at(day, 0, 0) + timedelta(hours=court.club.closing_hour)
        at = self._at(day, court.club.opening_hour, 0)
        made = 0
        while close - at >= timedelta(minutes=60):
            if rng.random() >= demand(at.hour, weekend) * growth:
                at += timedelta(minutes=rng.choice([30, 60]))
                continue
            minutes = min(rng.choice([60, 90, 90, 120]), int((close - at).total_seconds() // 60))
            if until and at + timedelta(minutes=minutes) > until:
                break
            name, phone = self._player(days_open)
            try:
                booking = create_booking(
                    court=court, start_at=at, end_at=at + timedelta(minutes=minutes), customer_name=name, customer_phone=phone
                )
            except BookingError:
                at += timedelta(minutes=30)
                continue
            at = booking.end_at
            if rng.random() < 0.03:
                cancel_booking(booking)
                continue
            made += 1
            self._bill(booking, now, today)
        return made

    def _bill(self, booking, now, today):
        """Buffet items, loyalty offers and payments that look like a real day."""
        rng = self.rng
        if rng.random() < 0.55:
            for product in rng.sample(self.products, rng.choice([1, 1, 2])):
                add_item(booking, product, quantity=rng.choice([1, 1, 2, 4]))
        if booking.end_at > now:
            return
        if rng.random() < 0.03:
            mark_no_show(booking)
            return
        found = offers(booking)
        if found and rng.random() < 0.8:
            apply_offer(booking, found[0]["kind"])
        # Recent days still have a few unpaid bills at the desk.
        age = (today - booking.start_at.astimezone(self.tz).date()).days
        if age <= 1 and rng.random() < 0.35:
            return
        due = totals(booking)["balance"]
        if due <= 0:
            return
        if booking.customer and balance_of(booking.customer) >= due and rng.random() < 0.7:
            payments = [add_payment(booking, due, "balance")]
            BalanceEntry.objects.filter(booking=booking).update(created_at=booking.end_at)
        elif rng.random() < 0.1:
            half = (due / 2).quantize(Decimal("1"))
            payments = [add_payment(booking, half, "cash"), add_payment(booking, due - half, "card")]
        else:
            method = rng.choices(["card", "cash", "transfer"], weights=[55, 30, 15])[0]
            payments = [add_payment(booking, due, method)]
        Payment.objects.filter(pk__in=[p.pk for p in payments]).update(created_at=booking.end_at)

    def _counter_sales(self, club, day, growth, now):
        """Drinks and snacks sold at the counter without a booking."""
        rng = self.rng
        for _ in range(rng.choice([0, 1, 1, 2, 3])):
            if rng.random() > growth:
                continue
            when = self._at(day, rng.randint(9, 22), rng.choice([0, 15, 30, 45]))
            if when > now:
                continue
            lines = [(product, rng.choice([1, 1, 2])) for product in rng.sample(self.products[:6], rng.choice([1, 2]))]
            sale = create_sale(club=club, lines=lines, method=rng.choice(["cash", "cash", "card"]))
            Sale.objects.filter(pk=sale.pk).update(created_at=when)
