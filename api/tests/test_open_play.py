from datetime import datetime
from decimal import Decimal
from unittest import mock
from zoneinfo import ZoneInfo

from django.urls import reverse

from bookings.models import Booking
from bookings.services import create_booking

from .test_api import ApiTestBase, payload

MSK = ZoneInfo("Europe/Moscow")


def at(hour, minute=0, second=0):
    return datetime(2026, 11, 2, hour, minute, second, tzinfo=MSK)


def frozen(moment):
    return mock.patch("django.utils.timezone.now", return_value=moment)


class OpenPlayTests(ApiTestBase):
    def start(self, court=None):
        return self.client.post(
            reverse("booking-start-open"),
            {"court": (court or self.court_a).pk, "customer_name": "Walk-in"},
            format="json",
        )

    def test_start_holds_the_court_until_closing(self):
        with frozen(at(18, 10, 42)):
            response = self.start()
        self.assertEqual(response.status_code, 201)
        booking = Booking.objects.get()
        self.assertTrue(booking.is_open)
        self.assertEqual(booking.start_at, at(18, 10))
        self.assertEqual(booking.end_at, datetime(2026, 11, 3, 0, 0, tzinfo=MSK))
        self.assertEqual(booking.price, Decimal("0"))

    def test_nothing_else_can_be_booked_on_that_court_while_open(self):
        with frozen(at(18, 10)):
            self.start()
        response = self.client.post(
            reverse("booking-list"), payload(self.court_a, "21:00", "22:00"), format="json"
        )
        self.assertEqual(response.status_code, 409)

    def test_cannot_start_when_the_court_is_booked_later_today(self):
        create_booking(court=self.court_a, start_at=at(21), end_at=at(22), customer_name="X")
        with frozen(at(18, 10)):
            response = self.start()
        self.assertEqual(response.status_code, 409)
        self.assertIn("later today", response.data["detail"])

    def test_cannot_start_outside_opening_hours(self):
        with frozen(at(7, 0)):
            self.assertEqual(self.start().status_code, 400)

    def test_stop_charges_the_exact_minutes_and_frees_the_court(self):
        with frozen(at(16, 40)):
            booking_id = self.start().data["id"]
        with frozen(at(17, 20, 59)):
            response = self.client.post(reverse("booking-stop", args=[booking_id]))
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.data["is_open"])
        # 20 min at 2000/h + 20 min at 3000/h
        self.assertEqual(Decimal(response.data["price"]), Decimal("1666.67"))
        self.assertEqual(Booking.objects.get().end_at, at(17, 20))

        later = self.client.post(
            reverse("booking-list"), payload(self.court_a, "21:00", "22:00"), format="json"
        )
        self.assertEqual(later.status_code, 201)

    def test_stop_after_closing_is_capped_at_closing(self):
        with frozen(at(23, 0)):
            booking_id = self.start().data["id"]
        with frozen(datetime(2026, 11, 3, 1, 30, tzinfo=MSK)):
            response = self.client.post(reverse("booking-stop", args=[booking_id]))
        # 60 minutes at 3000/h
        self.assertEqual(Decimal(response.data["price"]), Decimal("3000.00"))

    def test_stopping_a_normal_booking_is_rejected(self):
        booking = create_booking(court=self.court_a, start_at=at(10), end_at=at(11), customer_name="X")
        response = self.client.post(reverse("booking-stop", args=[booking.pk]))
        self.assertEqual(response.status_code, 400)

    def test_running_session_is_not_in_the_revenue_report(self):
        self.user_a.memberships.update(role="owner")
        with frozen(at(18, 10)):
            self.start()
        response = self.client.get(
            reverse("revenue-report"), {"club": self.club_a.pk, "from": "2026-11-02", "to": "2026-11-02"}
        )
        self.assertEqual(response.data["bookings"], 0)


class QuoteTests(ApiTestBase):
    def test_quote_prices_any_minute(self):
        response = self.client.get(
            reverse("court-quote", args=[self.court_a.pk]),
            {"start": "2026-11-02T10:10:00+03:00", "end": "2026-11-02T11:25:00+03:00"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(Decimal(response.data["price"]), Decimal("2500.00"))

    def test_quote_outside_hours_is_rejected(self):
        response = self.client.get(
            reverse("court-quote", args=[self.court_a.pk]),
            {"start": "2026-11-02T06:00:00+03:00", "end": "2026-11-02T07:00:00+03:00"},
        )
        self.assertEqual(response.status_code, 400)
