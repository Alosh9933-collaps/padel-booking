from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework.test import APITestCase

from bookings.models import Booking
from bookings.services import cancel_booking, create_booking
from clubs.access import can_manage, managed_clubs_of
from clubs.models import Court, Membership, PriceRule

from .test_api import make_club

MSK = ZoneInfo("Europe/Moscow")


def at(day, hour, minute=0):
    return datetime(2026, 11, day, hour, minute, tzinfo=MSK)


def results(response):
    return response.data["results"] if "results" in response.data else response.data


class ManagementTestBase(APITestCase):
    def setUp(self):
        User = get_user_model()
        self.club, self.court = make_club("Club A")
        self.other_club, self.other_court = make_club("Club B")

        def member(username, club, role):
            user = User.objects.create_user(username, password="pass-12345")
            Membership.objects.create(user=user, club=club, role=role)
            return user

        self.owner = member("owner", self.club, Membership.Role.OWNER)
        self.manager = member("manager", self.club, Membership.Role.MANAGER)
        self.receptionist = member("reception", self.club, Membership.Role.RECEPTIONIST)
        self.outsider = member("outsider", self.other_club, Membership.Role.OWNER)

    def as_user(self, user):
        self.client.force_authenticate(user)


class AccessHelperTests(ManagementTestBase):
    def test_receptionist_is_not_a_manager_even_if_the_club_has_an_owner(self):
        # Regression guard: user and role must match the same membership row.
        self.assertFalse(can_manage(self.receptionist, self.club))
        self.assertFalse(managed_clubs_of(self.receptionist).exists())

    def test_owner_and_manager_can_manage(self):
        self.assertTrue(can_manage(self.owner, self.club))
        self.assertTrue(can_manage(self.manager, self.club))

    def test_managing_one_club_does_not_extend_to_another(self):
        Membership.objects.create(
            user=self.receptionist, club=self.other_club, role=Membership.Role.MANAGER
        )
        self.assertFalse(can_manage(self.receptionist, self.club))
        self.assertTrue(can_manage(self.receptionist, self.other_club))


class CourtManagementTests(ManagementTestBase):
    def test_manager_creates_a_court(self):
        self.as_user(self.manager)
        response = self.client.post(
            reverse("court-list"),
            {"club": self.club.pk, "name": "Court 2", "kind": "outdoor"},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        self.assertTrue(Court.objects.filter(club=self.club, name="Court 2").exists())

    def test_receptionist_cannot_create_a_court(self):
        self.as_user(self.receptionist)
        response = self.client.post(
            reverse("court-list"), {"club": self.club.pk, "name": "Court 2"}, format="json"
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.club.courts.count(), 1)

    def test_receptionist_who_manages_another_club_still_cannot_create_here(self):
        Membership.objects.create(
            user=self.receptionist, club=self.other_club, role=Membership.Role.MANAGER
        )
        self.as_user(self.receptionist)
        response = self.client.post(
            reverse("court-list"), {"club": self.club.pk, "name": "Court 2"}, format="json"
        )
        self.assertEqual(response.status_code, 403)

    def test_cannot_create_a_court_in_a_foreign_club(self):
        self.as_user(self.owner)
        response = self.client.post(
            reverse("court-list"), {"club": self.other_club.pk, "name": "Sneaky"}, format="json"
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(Court.objects.filter(name="Sneaky").exists())

    def test_duplicate_court_name_is_rejected(self):
        self.as_user(self.owner)
        response = self.client.post(
            reverse("court-list"), {"club": self.club.pk, "name": "Court 1"}, format="json"
        )
        self.assertEqual(response.status_code, 400)

    def test_manager_deactivates_a_court(self):
        self.as_user(self.manager)
        response = self.client.patch(
            reverse("court-detail", args=[self.court.pk]), {"is_active": False}, format="json"
        )
        self.assertEqual(response.status_code, 200)
        self.court.refresh_from_db()
        self.assertFalse(self.court.is_active)

    def test_receptionist_cannot_edit_a_court(self):
        self.as_user(self.receptionist)
        response = self.client.patch(
            reverse("court-detail", args=[self.court.pk]), {"name": "Renamed"}, format="json"
        )
        self.assertEqual(response.status_code, 403)

    def test_court_cannot_move_to_another_club(self):
        Membership.objects.create(
            user=self.owner, club=self.other_club, role=Membership.Role.OWNER
        )
        self.as_user(self.owner)
        response = self.client.patch(
            reverse("court-detail", args=[self.court.pk]),
            {"club": self.other_club.pk},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    def test_courts_cannot_be_deleted(self):
        self.as_user(self.owner)
        response = self.client.delete(reverse("court-detail", args=[self.court.pk]))
        self.assertEqual(response.status_code, 405)


class PriceRuleManagementTests(ManagementTestBase):
    def rule_payload(self, **overrides):
        data = {
            "club": self.club.pk,
            "days_of_week": [5, 6],
            "start_hour": 8,
            "end_hour": 12,
            "price_per_hour": "2500.00",
            "priority": 1,
        }
        data.update(overrides)
        return data

    def test_manager_creates_a_rule_that_changes_the_price(self):
        self.as_user(self.manager)
        response = self.client.post(reverse("pricerule-list"), self.rule_payload(), format="json")
        self.assertEqual(response.status_code, 201)

        # 7 Nov 2026 is a Saturday.
        booking = create_booking(
            court=self.court, start_at=at(7, 10), end_at=at(7, 11), customer_name="X"
        )
        self.assertEqual(booking.price, Decimal("2500.00"))

    def test_receptionist_can_read_but_not_write_rules(self):
        self.as_user(self.receptionist)
        self.assertEqual(self.client.get(reverse("pricerule-list")).status_code, 200)
        response = self.client.post(reverse("pricerule-list"), self.rule_payload(), format="json")
        self.assertEqual(response.status_code, 403)

    def test_start_must_be_before_end(self):
        self.as_user(self.owner)
        response = self.client.post(
            reverse("pricerule-list"), self.rule_payload(start_hour=12, end_hour=8), format="json"
        )
        self.assertEqual(response.status_code, 400)

    def test_court_of_another_club_is_rejected(self):
        self.as_user(self.owner)
        response = self.client.post(
            reverse("pricerule-list"), self.rule_payload(court=self.other_court.pk), format="json"
        )
        self.assertEqual(response.status_code, 400)

    def test_deleting_a_rule_keeps_old_booking_prices(self):
        booking = create_booking(
            court=self.court, start_at=at(2, 10), end_at=at(2, 11), customer_name="X"
        )
        rule = PriceRule.objects.get(club=self.club, start_hour=8)
        self.as_user(self.owner)
        response = self.client.delete(reverse("pricerule-detail", args=[rule.pk]))
        self.assertEqual(response.status_code, 204)
        booking.refresh_from_db()
        self.assertEqual(booking.price, Decimal("2000.00"))

    def test_rules_of_other_clubs_are_invisible(self):
        self.as_user(self.owner)
        clubs = {r["club"] for r in results(self.client.get(reverse("pricerule-list")))}
        self.assertEqual(clubs, {self.club.pk})


class ClubSettingsTests(ManagementTestBase):
    def test_club_list_shows_my_role(self):
        self.as_user(self.receptionist)
        data = results(self.client.get(reverse("club-list")))
        self.assertEqual([(c["id"], c["role"]) for c in data], [(self.club.pk, "receptionist")])

    def test_manager_changes_opening_hours(self):
        self.as_user(self.manager)
        response = self.client.patch(
            reverse("club-detail", args=[self.club.pk]),
            {"opening_hour": 7, "closing_hour": 23},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["role"], "manager")
        self.club.refresh_from_db()
        self.assertEqual((self.club.opening_hour, self.club.closing_hour), (7, 23))

    def test_receptionist_cannot_change_settings(self):
        self.as_user(self.receptionist)
        response = self.client.patch(
            reverse("club-detail", args=[self.club.pk]), {"opening_hour": 6}, format="json"
        )
        self.assertEqual(response.status_code, 403)

    def test_invalid_hours_and_timezone_are_rejected(self):
        self.as_user(self.owner)
        url = reverse("club-detail", args=[self.club.pk])
        self.assertEqual(
            self.client.patch(url, {"opening_hour": 20, "closing_hour": 10}, format="json").status_code,
            400,
        )
        self.assertEqual(
            self.client.patch(url, {"timezone": "Mars/Olympus"}, format="json").status_code, 400
        )

    def test_foreign_club_is_not_found(self):
        self.as_user(self.owner)
        response = self.client.get(reverse("club-detail", args=[self.other_club.pk]))
        self.assertEqual(response.status_code, 404)


class RevenueReportTests(ManagementTestBase):
    def setUp(self):
        super().setUp()
        self.court2 = Court.objects.create(club=self.club, name="Court 2")
        create_booking(court=self.court, start_at=at(2, 10), end_at=at(2, 11), customer_name="A")
        create_booking(court=self.court2, start_at=at(2, 18), end_at=at(2, 19), customer_name="B")
        create_booking(court=self.court, start_at=at(3, 23), end_at=at(4, 0), customer_name="C")
        cancelled = create_booking(
            court=self.court, start_at=at(3, 10), end_at=at(3, 11), customer_name="D"
        )
        cancel_booking(cancelled)
        # Outside the range, and in another club.
        create_booking(court=self.court, start_at=at(9, 10), end_at=at(9, 11), customer_name="E")
        create_booking(
            court=self.other_court, start_at=at(2, 10), end_at=at(2, 11), customer_name="F"
        )

    def report(self, **params):
        query = {"club": self.club.pk, "from": "2026-11-01", "to": "2026-11-07"}
        query.update(params)
        return self.client.get(reverse("revenue-report"), query)

    def test_totals_by_court_and_by_day(self):
        self.as_user(self.manager)
        response = self.report()
        self.assertEqual(response.status_code, 200)
        data = response.data
        self.assertEqual(Decimal(data["total"]), Decimal("8000.00"))
        self.assertEqual(data["bookings"], 3)
        self.assertEqual(
            [(c["court_name"], Decimal(c["total"])) for c in data["by_court"]],
            [("Court 1", Decimal("5000.00")), ("Court 2", Decimal("3000.00"))],
        )
        # The 23:00 booking on 3 Nov is 20:00 UTC; it must count on the club's local day.
        self.assertEqual(
            [(d["date"], Decimal(d["total"])) for d in data["by_day"]],
            [("2026-11-02", Decimal("5000.00")), ("2026-11-03", Decimal("3000.00"))],
        )

    def test_empty_range_returns_zero(self):
        self.as_user(self.owner)
        data = self.report(**{"from": "2026-12-01", "to": "2026-12-02"}).data
        self.assertEqual(Decimal(data["total"]), Decimal("0"))
        self.assertEqual(data["bookings"], 0)

    def test_receptionist_gets_403(self):
        self.as_user(self.receptionist)
        self.assertEqual(self.report().status_code, 403)

    def test_foreign_club_gets_404(self):
        self.as_user(self.outsider)
        self.assertEqual(self.report().status_code, 404)

    def test_bad_parameters_return_400(self):
        self.as_user(self.owner)
        self.assertEqual(self.report(**{"from": "2026-11-07", "to": "2026-11-01"}).status_code, 400)
        self.assertEqual(self.report(**{"to": "07-11-2026"}).status_code, 400)
        self.assertEqual(
            self.client.get(reverse("revenue-report"), {"club": self.club.pk}).status_code, 400
        )


class ReceptionistBookingTests(ManagementTestBase):
    def test_receptionist_can_book_and_cancel(self):
        self.as_user(self.receptionist)
        response = self.client.post(
            reverse("booking-list"),
            {
                "court": self.court.pk,
                "start_at": "2026-11-02T10:00:00+03:00",
                "end_at": "2026-11-02T11:00:00+03:00",
                "customer_name": "Walk-in",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        cancel = self.client.post(reverse("booking-cancel", args=[response.data["id"]]))
        self.assertEqual(cancel.status_code, 200)
        self.assertEqual(Booking.objects.get().status, "cancelled")
