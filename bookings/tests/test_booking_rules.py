from datetime import datetime
from decimal import Decimal
from threading import Thread
from zoneinfo import ZoneInfo

from django.db import connection
from django.test import TestCase, TransactionTestCase

from bookings.models import Booking
from bookings.services import (
    InvalidBookingTime,
    PriceNotConfigured,
    SlotUnavailable,
    calculate_price,
    cancel_booking,
    create_booking,
)
from clubs.models import Club, Court, PriceRule

MSK = ZoneInfo("Europe/Moscow")
ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]


def msk(hour, minute=0, day=2):
    """A Moscow-time datetime in November 2026. 2 Nov 2026 is a Monday."""
    return datetime(2026, 11, day, hour, minute, tzinfo=MSK)


def make_club_with_prices():
    club = Club.objects.create(
        name="Test Club", timezone="Europe/Moscow", opening_hour=8, closing_hour=24, slot_minutes=30
    )
    court = Court.objects.create(club=club, name="Court 1")
    PriceRule.objects.create(
        club=club, days_of_week=ALL_DAYS, start_hour=8, end_hour=17, price_per_hour=Decimal("2000")
    )
    PriceRule.objects.create(
        club=club, days_of_week=ALL_DAYS, start_hour=17, end_hour=24, price_per_hour=Decimal("3000")
    )
    return club, court


class PricingTests(TestCase):
    def setUp(self):
        self.club, self.court = make_club_with_prices()

    def test_price_spans_two_rules(self):
        # 16:30-17:00 at 2000/h = 1000, 17:00-18:00 at 3000/h = 3000
        price = calculate_price(self.court, msk(16, 30), msk(18))
        self.assertEqual(price, Decimal("4000.00"))

    def test_court_specific_rule_wins_on_tie(self):
        PriceRule.objects.create(
            club=self.club,
            court=self.court,
            days_of_week=ALL_DAYS,
            start_hour=8,
            end_hour=17,
            price_per_hour=Decimal("2500"),
        )
        self.assertEqual(calculate_price(self.court, msk(10), msk(11)), Decimal("2500.00"))

    def test_missing_rule_raises(self):
        PriceRule.objects.all().delete()
        with self.assertRaises(PriceNotConfigured):
            calculate_price(self.court, msk(10), msk(11))


class BookingRuleTests(TestCase):
    def setUp(self):
        self.club, self.court = make_club_with_prices()

    def book(self, start, end, court=None):
        return create_booking(
            court=court or self.court, start_at=start, end_at=end, customer_name="Ali"
        )

    def test_price_is_frozen_on_the_booking(self):
        booking = self.book(msk(10), msk(11, 30))
        self.assertEqual(booking.price, Decimal("3000.00"))

    def test_overlapping_booking_is_rejected(self):
        self.book(msk(10), msk(11))
        with self.assertRaises(SlotUnavailable):
            self.book(msk(10, 30), msk(11, 30))

    def test_back_to_back_bookings_are_allowed(self):
        self.book(msk(10), msk(11))
        self.book(msk(11), msk(12))
        self.assertEqual(Booking.objects.count(), 2)

    def test_same_time_on_another_court_is_allowed(self):
        other = Court.objects.create(club=self.club, name="Court 2")
        self.book(msk(10), msk(11))
        self.book(msk(10), msk(11), court=other)
        self.assertEqual(Booking.objects.count(), 2)

    def test_cancelled_booking_frees_the_slot(self):
        booking = self.book(msk(10), msk(11))
        cancel_booking(booking)
        self.book(msk(10), msk(11))
        self.assertEqual(Booking.objects.filter(status="confirmed").count(), 1)

    def test_outside_opening_hours_is_rejected(self):
        with self.assertRaises(InvalidBookingTime):
            self.book(msk(7), msk(8))

    def test_booking_until_midnight_is_allowed(self):
        self.book(msk(23), msk(0, day=3))

    def test_off_grid_time_is_rejected(self):
        with self.assertRaises(InvalidBookingTime):
            self.book(msk(10, 10), msk(11, 10))

    def test_naive_datetimes_are_rejected(self):
        with self.assertRaises(InvalidBookingTime):
            self.book(datetime(2026, 11, 2, 10), datetime(2026, 11, 2, 11))


class ConcurrentBookingTests(TransactionTestCase):
    """Real parallel transactions: the database must let exactly one win."""

    def test_only_one_of_many_parallel_requests_succeeds(self):
        _, court = make_club_with_prices()
        results = []

        def worker():
            try:
                create_booking(
                    court=court, start_at=msk(10), end_at=msk(11), customer_name="Racer"
                )
                results.append("ok")
            except SlotUnavailable:
                results.append("conflict")
            finally:
                connection.close()

        threads = [Thread(target=worker) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(results.count("ok"), 1)
        self.assertEqual(results.count("conflict"), 5)
        self.assertEqual(Booking.objects.filter(status="confirmed").count(), 1)