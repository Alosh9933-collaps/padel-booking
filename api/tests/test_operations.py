from datetime import datetime
from decimal import Decimal
from unittest import mock
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.urls import reverse

from bookings.models import Booking, Payment
from bookings.services import create_booking
from buffet.models import Product
from clubs.models import Customer, Membership

from .test_api import DAY, ApiTestBase, payload

MSK = ZoneInfo("Europe/Moscow")


def at(day, hour, minute=0):
    return datetime(2026, 11, day, hour, minute, tzinfo=MSK)


class OperationsTestBase(ApiTestBase):
    def setUp(self):
        super().setUp()
        self.water = Product.objects.create(club=self.club_a, name="Water", category="Drinks", price=Decimal("100"))
        self.bar = Product.objects.create(club=self.club_a, name="Protein bar", price=Decimal("250"))
        self.foreign = Product.objects.create(club=self.club_b, name="Cola", price=Decimal("150"))
        # 10:00-11:00 at 2000/h
        self.booking = create_booking(
            court=self.court_a, start_at=at(2, 10), end_at=at(2, 11), customer_name="Ali"
        )

    def make_manager(self):
        Membership.objects.filter(user=self.user_a, club=self.club_a).update(role="manager")

    def add_item(self, product, quantity=1, booking=None):
        return self.client.post(
            reverse("booking-items", args=[(booking or self.booking).pk]),
            {"product": product.pk, "quantity": quantity},
            format="json",
        )

    def pay(self, amount, method="cash", booking=None):
        return self.client.post(
            reverse("booking-payments", args=[(booking or self.booking).pk]),
            {"amount": amount, "method": method},
            format="json",
        )


class CustomerTests(OperationsTestBase):
    def test_booking_with_phone_creates_and_reuses_the_customer(self):
        self.client.post(reverse("booking-list"), payload(self.court_a, "12:00", "13:00"), format="json")
        second = payload(self.court_a, "14:00", "15:00", name="Ali again")
        second["customer_phone"] = "+7 (900) 000-00-00"
        self.client.post(reverse("booking-list"), second, format="json")

        customer = Customer.objects.get()
        self.assertEqual(customer.phone, "+79000000000")
        self.assertEqual(customer.name, "Ali")
        self.assertEqual(customer.bookings.count(), 2)

    def test_search_and_history(self):
        self.client.post(reverse("booking-list"), payload(self.court_a, "12:00", "13:00"), format="json")
        response = self.client.get(reverse("customer-list"), {"search": "900 000"})
        data = response.data["results"] if "results" in response.data else response.data
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["visits"], 1)
        self.assertEqual(Decimal(data[0]["spent"]), Decimal("2000.00"))

    def test_customers_of_other_clubs_are_invisible(self):
        Customer.objects.create(club=self.club_b, name="Other", phone="123456")
        response = self.client.get(reverse("customer-list"))
        data = response.data["results"] if "results" in response.data else response.data
        self.assertEqual(data, [])

    def test_duplicate_phone_is_rejected(self):
        Customer.objects.create(club=self.club_a, name="A", phone="+79001112233")
        response = self.client.post(
            reverse("customer-list"),
            {"club": self.club_a.pk, "name": "B", "phone": "+7 900 111 22 33"},
            format="json",
        )
        self.assertEqual(response.status_code, 400)


class BillTests(OperationsTestBase):
    def test_items_add_up_on_the_bill(self):
        self.add_item(self.water)
        self.add_item(self.water, 2)
        response = self.add_item(self.bar)
        self.assertEqual(response.status_code, 201)
        data = response.data
        self.assertEqual([(i["name"], i["quantity"]) for i in data["items"]], [("Water", 3), ("Protein bar", 1)])
        self.assertEqual(Decimal(data["items_total"]), Decimal("550.00"))
        self.assertEqual(Decimal(data["total"]), Decimal("2550.00"))
        self.assertEqual(data["payment_status"], "unpaid")

    def test_quantity_zero_removes_the_item(self):
        item_id = self.add_item(self.water).data["items"][0]["id"]
        response = self.client.patch(
            reverse("booking-item", args=[self.booking.pk, item_id]), {"quantity": 0}, format="json"
        )
        self.assertEqual(response.data["items"], [])

    def test_old_bills_keep_the_old_price(self):
        self.add_item(self.water)
        self.water.price = Decimal("120")
        self.water.save()
        data = self.client.get(reverse("booking-detail", args=[self.booking.pk])).data
        self.assertEqual(Decimal(data["items"][0]["unit_price"]), Decimal("100.00"))

    def test_product_of_another_club_is_rejected(self):
        response = self.add_item(self.foreign)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["code"], "product_unavailable")

    def test_split_payment(self):
        self.add_item(self.water, 5)  # 2000 + 500
        first = self.pay("1250", "cash")
        self.assertEqual(first.data["payment_status"], "partial")
        second = self.pay("1250", "card")
        self.assertEqual(second.data["payment_status"], "paid")
        self.assertEqual(Decimal(second.data["balance"]), Decimal("0.00"))
        self.assertEqual(len(second.data["payments"]), 2)

    def test_overpayment_is_rejected_with_a_code(self):
        response = self.pay("2500")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["code"], "overpayment")

    def test_cancelled_booking_cannot_be_billed(self):
        self.client.post(reverse("booking-cancel", args=[self.booking.pk]))
        self.assertEqual(self.add_item(self.water).data["code"], "booking_cancelled")

    def test_only_managers_remove_payments(self):
        payment_id = self.pay("500").data["payments"][0]["id"]
        url = reverse("booking-payment", args=[self.booking.pk, payment_id])
        self.assertEqual(self.client.delete(url).status_code, 403)
        self.make_manager()
        self.assertEqual(self.client.delete(url).status_code, 200)
        self.assertFalse(Payment.objects.exists())

    def test_receptionist_cannot_edit_the_menu(self):
        response = self.client.post(
            reverse("product-list"), {"club": self.club_a.pk, "name": "Tea", "price": "80"}, format="json"
        )
        self.assertEqual(response.status_code, 403)
        self.make_manager()
        response = self.client.post(
            reverse("product-list"), {"club": self.club_a.pk, "name": "Tea", "price": "80"}, format="json"
        )
        self.assertEqual(response.status_code, 201)


class NoShowTests(OperationsTestBase):
    def test_no_show_only_after_the_start(self):
        url = reverse("booking-no-show", args=[self.booking.pk])
        with mock.patch("django.utils.timezone.now", return_value=at(2, 9)):
            response = self.client.post(url)
        self.assertEqual(response.data["code"], "no_show_too_early")
        with mock.patch("django.utils.timezone.now", return_value=at(2, 10, 20)):
            response = self.client.post(url)
        self.assertEqual(response.data["status"], "no_show")
        # The court is free again.
        again = self.client.post(reverse("booking-list"), payload(self.court_a), format="json")
        self.assertEqual(again.status_code, 201)


class WeeklyTests(OperationsTestBase):
    def weekly(self, weeks=4, dry_run=False):
        data = payload(self.court_a, "19:00", "20:30", name="Tuesday group")
        data.update(weeks=weeks, dry_run=dry_run)
        return self.client.post(reverse("booking-weekly"), data, format="json")

    def test_dry_run_books_nothing_and_shows_conflicts(self):
        create_booking(court=self.court_a, start_at=at(16, 19), end_at=at(16, 20), customer_name="X")
        response = self.weekly(dry_run=True)
        self.assertEqual(response.status_code, 200)
        self.assertEqual([w["ok"] for w in response.data["skipped"]], [True, True, False, True])
        self.assertEqual(Booking.objects.filter(customer_name="Tuesday group").count(), 0)

    def test_books_free_weeks_and_skips_taken_ones(self):
        create_booking(court=self.court_a, start_at=at(16, 19), end_at=at(16, 20), customer_name="X")
        response = self.weekly()
        self.assertEqual(response.status_code, 201)
        self.assertEqual(len(response.data["created"]), 3)
        self.assertEqual(response.data["skipped"][0]["code"], "slot_unavailable")
        series = {b["series"] for b in response.data["created"]}
        self.assertEqual(len(series), 1)

    def test_cancel_following(self):
        created = self.weekly().data["created"]
        response = self.client.post(reverse("booking-cancel-following", args=[created[1]["id"]]))
        self.assertEqual(len(response.data), 3)
        statuses = list(
            Booking.objects.filter(customer_name="Tuesday group").order_by("start_at").values_list("status", flat=True)
        )
        self.assertEqual(statuses, ["confirmed", "cancelled", "cancelled", "cancelled"])


class StaffTests(OperationsTestBase):
    def staff(self, username, role, password="strong-pass-123"):
        return self.client.post(
            reverse("staff-list"),
            {"club": self.club_a.pk, "username": username, "password": password, "role": role},
            format="json",
        )

    def test_receptionist_cannot_manage_staff(self):
        self.assertEqual(self.staff("new", "receptionist").status_code, 403)

    def test_manager_adds_receptionists_only(self):
        self.make_manager()
        self.assertEqual(self.staff("desk2", "receptionist").status_code, 201)
        self.assertEqual(self.staff("boss2", "manager").status_code, 403)
        self.assertTrue(get_user_model().objects.get(username="desk2").check_password("strong-pass-123"))

    def test_owner_adds_a_manager_and_cannot_remove_self(self):
        Membership.objects.filter(user=self.user_a).update(role="owner")
        self.assertEqual(self.staff("boss2", "manager").status_code, 201)
        mine = Membership.objects.get(user=self.user_a)
        self.assertEqual(self.client.delete(reverse("staff-detail", args=[mine.pk])).status_code, 403)

    def test_weak_password_is_rejected(self):
        self.make_manager()
        self.assertEqual(self.staff("desk3", "receptionist", password="123").status_code, 400)


class ReportTests(OperationsTestBase):
    def test_daily_report(self):
        self.add_item(self.water, 2)
        with mock.patch("django.utils.timezone.now", return_value=at(2, 11)):
            self.pay("1000", "cash")
            self.pay("500", "card")
        response = self.client.get(reverse("daily-report"), {"club": self.club_a.pk, "date": DAY})
        self.assertEqual(response.status_code, 200)
        data = response.data
        self.assertEqual(Decimal(data["received"]), Decimal("1500.00"))
        self.assertEqual({m["method"] for m in data["by_method"]}, {"cash", "card"})
        self.assertEqual(data["buffet"][0]["name"], "Water")
        self.assertEqual(Decimal(data["unpaid_total"]), Decimal("700.00"))

    def test_revenue_report_includes_buffet(self):
        self.make_manager()
        self.add_item(self.bar, 2)
        response = self.client.get(
            reverse("revenue-report"), {"club": self.club_a.pk, "from": DAY, "to": DAY}
        )
        self.assertEqual(Decimal(response.data["buffet_total"]), Decimal("500.00"))
        self.assertEqual(Decimal(response.data["grand_total"]), Decimal("2500.00"))
        self.assertEqual(Decimal(response.data["by_day"][0]["buffet"]), Decimal("500.00"))
