from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework.test import APITestCase

from bookings.models import Booking
from bookings.services import create_booking
from clubs.models import Club, Court, Membership, PriceRule

MSK = ZoneInfo("Europe/Moscow")
ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
DAY = "2026-11-02"  # a Monday


def msk(hour, minute=0):
    return datetime(2026, 11, 2, hour, minute, tzinfo=MSK)


def make_club(name):
    club = Club.objects.create(
        name=name, timezone="Europe/Moscow", opening_hour=8, closing_hour=24, slot_minutes=30
    )
    court = Court.objects.create(club=club, name="Court 1")
    PriceRule.objects.create(
        club=club, days_of_week=ALL_DAYS, start_hour=8, end_hour=17, price_per_hour=Decimal("2000")
    )
    PriceRule.objects.create(
        club=club, days_of_week=ALL_DAYS, start_hour=17, end_hour=24, price_per_hour=Decimal("3000")
    )
    return club, court


def payload(court, start="10:00", end="11:00", name="Ali"):
    return {
        "court": court.pk,
        "start_at": f"{DAY}T{start}:00+03:00",
        "end_at": f"{DAY}T{end}:00+03:00",
        "customer_name": name,
        "customer_phone": "+7 900 000 00 00",
    }


class ApiTestBase(APITestCase):
    def setUp(self):
        User = get_user_model()
        self.club_a, self.court_a = make_club("Club A")
        self.club_b, self.court_b = make_club("Club B")
        self.user_a = User.objects.create_user("user_a", password="pass-12345")
        self.user_b = User.objects.create_user("user_b", password="pass-12345")
        Membership.objects.create(user=self.user_a, club=self.club_a)
        Membership.objects.create(user=self.user_b, club=self.club_b)
        self.client.force_authenticate(self.user_a)


class AuthTests(ApiTestBase):
    def test_anonymous_requests_are_rejected(self):
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get(reverse("court-list")).status_code, 401)

    def test_jwt_login_gives_access_to_the_api(self):
        self.client.force_authenticate(None)
        response = self.client.post(
            reverse("token_obtain_pair"),
            {"username": "user_a", "password": "pass-12345"},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {response.data['access']}")
        self.assertEqual(self.client.get(reverse("court-list")).status_code, 200)


class ClubScopingTests(ApiTestBase):
    def test_user_sees_only_courts_of_their_own_club(self):
        response = self.client.get(reverse("court-list"))
        ids = [c["id"] for c in response.data["results"]] if "results" in response.data else [
            c["id"] for c in response.data
        ]
        self.assertEqual(ids, [self.court_a.pk])

    def test_other_clubs_court_is_not_found(self):
        response = self.client.get(reverse("court-detail", args=[self.court_b.pk]))
        self.assertEqual(response.status_code, 404)

    def test_cannot_book_a_court_of_another_club(self):
        response = self.client.post(reverse("booking-list"), payload(self.court_b), format="json")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Booking.objects.count(), 0)

    def test_cannot_cancel_a_booking_of_another_club(self):
        booking = create_booking(
            court=self.court_b, start_at=msk(10), end_at=msk(11), customer_name="X"
        )
        response = self.client.post(reverse("booking-cancel", args=[booking.pk]))
        self.assertEqual(response.status_code, 404)
        booking.refresh_from_db()
        self.assertEqual(booking.status, "confirmed")


class AvailabilityTests(ApiTestBase):
    def test_booked_slots_are_marked_unavailable(self):
        create_booking(court=self.court_a, start_at=msk(10), end_at=msk(11), customer_name="X")
        url = reverse("court-availability", args=[self.court_a.pk])
        response = self.client.get(url, {"date": DAY})

        self.assertEqual(response.status_code, 200)
        slots = response.data["slots"]
        self.assertEqual(len(slots), 32)  # 08:00-24:00 in 30-minute steps
        by_start = {s["start"][11:16]: s for s in slots}
        self.assertFalse(by_start["10:00"]["available"])
        self.assertFalse(by_start["10:30"]["available"])
        self.assertTrue(by_start["09:30"]["available"])
        self.assertTrue(by_start["11:00"]["available"])
        self.assertEqual(Decimal(by_start["11:00"]["price"]), Decimal("1000.00"))

    def test_bad_date_is_rejected(self):
        url = reverse("court-availability", args=[self.court_a.pk])
        self.assertEqual(self.client.get(url, {"date": "02-11-2026"}).status_code, 400)


class BookingApiTests(ApiTestBase):
    def test_create_booking(self):
        response = self.client.post(reverse("booking-list"), payload(self.court_a), format="json")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(Decimal(response.data["price"]), Decimal("2000.00"))
        booking = Booking.objects.get()
        self.assertEqual(booking.created_by, self.user_a)

    def test_double_booking_returns_409(self):
        self.client.post(reverse("booking-list"), payload(self.court_a), format="json")
        response = self.client.post(
            reverse("booking-list"), payload(self.court_a, "10:30", "11:30"), format="json"
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(Booking.objects.count(), 1)

    def test_outside_opening_hours_returns_400(self):
        response = self.client.post(
            reverse("booking-list"), payload(self.court_a, "06:00", "07:00"), format="json"
        )
        self.assertEqual(response.status_code, 400)

    def test_cancel_then_rebook_the_same_slot(self):
        created = self.client.post(reverse("booking-list"), payload(self.court_a), format="json")
        cancel = self.client.post(reverse("booking-cancel", args=[created.data["id"]]))
        self.assertEqual(cancel.status_code, 200)
        self.assertEqual(cancel.data["status"], "cancelled")

        again = self.client.post(reverse("booking-list"), payload(self.court_a), format="json")
        self.assertEqual(again.status_code, 201)

    def test_list_filters_by_date_and_hides_other_clubs(self):
        create_booking(court=self.court_a, start_at=msk(10), end_at=msk(11), customer_name="Mine")
        create_booking(court=self.court_b, start_at=msk(10), end_at=msk(11), customer_name="Theirs")
        response = self.client.get(reverse("booking-list"), {"date": DAY})
        data = response.data["results"] if "results" in response.data else response.data
        self.assertEqual([b["customer_name"] for b in data], ["Mine"])