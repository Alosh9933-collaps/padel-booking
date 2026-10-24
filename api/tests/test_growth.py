from datetime import datetime, timedelta
from decimal import Decimal
from unittest import mock
from zoneinfo import ZoneInfo

from django.core.cache import cache
from django.test import override_settings
from django.urls import reverse

from bookings.models import Booking
from bookings.services import create_booking
from buffet.models import Product
from clubs.models import Customer, Membership
from notify.management.commands.send_reminders import send_due_reminders
from notify.management.commands.telegram_bot import handle_message
from wallet.models import BalanceEntry, TopUpPlan

from .test_api import ApiTestBase, make_club

MSK = ZoneInfo("Europe/Moscow")
PHONE = "+7 900 555-00-11"


def at(day, hour, minute=0):
    return datetime(2026, 11, day, hour, minute, tzinfo=MSK)


def frozen(moment):
    return mock.patch("django.utils.timezone.now", return_value=moment)


class GrowthTestBase(ApiTestBase):
    def setUp(self):
        super().setUp()
        cache.clear()  # throttling counters live in the cache
        # 10:00-11:00 at 2000/h, with a customer.
        self.booking = create_booking(
            court=self.court_a, start_at=at(2, 10), end_at=at(2, 11), customer_name="Ali", customer_phone=PHONE
        )
        self.customer = self.booking.customer

    def make_manager(self):
        Membership.objects.filter(user=self.user_a).update(role="manager")

    def topup(self, **data):
        return self.client.post(reverse("customer-topup", args=[self.customer.pk]), data, format="json")

    def pay(self, amount, method="balance", booking=None):
        return self.client.post(
            reverse("booking-payments", args=[(booking or self.booking).pk]), {"amount": amount, "method": method}, format="json"
        )


class WalletTests(GrowthTestBase):
    def test_package_gives_the_bonus_credit(self):
        plan = TopUpPlan.objects.create(club=self.club_a, name="Gold", price=Decimal("10000"), credit=Decimal("11500"))
        entry = self.topup(plan=plan.pk, method="card").data
        self.assertEqual((Decimal(entry["paid"]), Decimal(entry["amount"])), (Decimal("10000.00"), Decimal("11500.00")))
        customer = self.client.get(reverse("customer-detail", args=[self.customer.pk])).data
        self.assertEqual(Decimal(customer["balance"]), Decimal("11500.00"))

    def test_pay_a_bill_from_the_balance(self):
        self.topup(paid="1500", method="cash")
        self.assertEqual(self.pay("2000").data["code"], "balance_too_low")
        data = self.pay("1500").data
        self.assertEqual(Decimal(data["customer_balance"]), Decimal("0.00"))
        self.assertEqual(data["payment_status"], "partial")

    def test_refund_to_balance_and_removed_payment_go_back(self):
        self.topup(paid="2000", method="cash")
        payment = self.pay("2000").data["payments"][0]
        self.client.post(reverse("booking-cancel", args=[self.booking.pk]))
        data = self.client.post(
            reverse("booking-refunds", args=[self.booking.pk]), {"amount": "2000", "method": "balance"}, format="json"
        ).data
        self.assertEqual(Decimal(data["customer_balance"]), Decimal("2000.00"))
        self.assertEqual(payment["method"], "balance")

    def test_manager_removing_a_balance_payment_restores_the_balance(self):
        self.topup(paid="1000", method="cash")
        payment_id = self.pay("1000").data["payments"][0]["id"]
        self.make_manager()
        data = self.client.delete(reverse("booking-payment", args=[self.booking.pk, payment_id])).data
        self.assertEqual(Decimal(data["customer_balance"]), Decimal("1000.00"))

    def test_booking_without_a_customer_cannot_use_a_balance(self):
        anonymous = create_booking(court=self.court_a, start_at=at(2, 12), end_at=at(2, 13), customer_name="X")
        self.assertEqual(self.pay("100", booking=anonymous).data["code"], "no_customer")

    def test_counter_sale_from_balance_and_void(self):
        water = Product.objects.create(club=self.club_a, name="Water", price=Decimal("100"))
        self.topup(paid="500", method="cash")
        sale = self.client.post(
            reverse("sale-list"),
            {"club": self.club_a.pk, "items": [{"product": water.pk, "quantity": 3}], "method": "balance", "customer_phone": PHONE},
            format="json",
        ).data
        self.assertEqual(sum(e.amount for e in BalanceEntry.objects.all()), Decimal("200.00"))
        self.client.post(reverse("sale-void", args=[sale["id"]]), {}, format="json")
        self.assertEqual(sum(e.amount for e in BalanceEntry.objects.all()), Decimal("500.00"))

    def test_top_ups_are_money_in_and_balance_use_is_not(self):
        with frozen(at(2, 12)):
            self.client.post(reverse("shift-open"), {"club": self.club_a.pk, "opening_cash": "0"}, format="json")
            self.topup(paid="3000", method="cash")
            self.pay("2000")
            shift = self.client.get(reverse("shift-current"), {"club": self.club_a.pk}).data
        self.assertEqual(Decimal(shift["expected"]), Decimal("3000.00"))
        data = self.client.get(reverse("daily-report"), {"club": self.club_a.pk, "date": "2026-11-02"}).data
        self.assertEqual(Decimal(data["received"]), Decimal("3000.00"))
        self.assertEqual(Decimal(data["topups_total"]), Decimal("3000.00"))
        self.assertEqual(Decimal(data["balance_used"]), Decimal("2000.00"))

    def test_bad_plan_and_amounts(self):
        other = TopUpPlan.objects.create(club=self.club_b, name="Theirs", price=Decimal("100"), credit=Decimal("100"))
        self.assertEqual(self.topup(plan=other.pk, method="cash").data["code"], "plan_unavailable")
        self.assertEqual(self.topup(paid="100", credit="50", method="cash").data["code"], "bad_amount")

    def test_only_managers_edit_packages(self):
        body = {"club": self.club_a.pk, "name": "Silver", "price": "5000", "credit": "5500"}
        self.assertEqual(self.client.post(reverse("topupplan-list"), body, format="json").status_code, 403)
        self.make_manager()
        self.assertEqual(self.client.post(reverse("topupplan-list"), body, format="json").status_code, 201)


class SearchAndMoveTests(GrowthTestBase):
    def test_search_by_name_and_phone(self):
        create_booking(court=self.court_a, start_at=at(3, 10), end_at=at(3, 11), customer_name="Maria")
        names = [b["customer_name"] for b in self.client.get(reverse("booking-list"), {"search": "ali"}).data]
        self.assertEqual(names, ["Ali"])
        names = [b["customer_name"] for b in self.client.get(reverse("booking-list"), {"search": "555 00"}).data]
        self.assertEqual(names, ["Ali"])

    def test_move_to_another_court(self):
        from clubs.models import Court

        court2 = Court.objects.create(club=self.club_a, name="Court 2")
        data = self.client.patch(reverse("booking-detail", args=[self.booking.pk]), {"court": court2.pk}, format="json").data
        self.assertEqual(data["court"], court2.pk)

    def test_cannot_move_onto_another_booking_or_club(self):
        from clubs.models import Court

        court2 = Court.objects.create(club=self.club_a, name="Court 2")
        create_booking(court=court2, start_at=at(2, 10), end_at=at(2, 11), customer_name="Busy")
        url = reverse("booking-detail", args=[self.booking.pk])
        self.assertEqual(self.client.patch(url, {"court": court2.pk}, format="json").status_code, 409)
        self.assertEqual(self.client.patch(url, {"court": self.court_b.pk}, format="json").status_code, 400)


class DashboardTests(GrowthTestBase):
    def test_dashboard_numbers(self):
        self.make_manager()
        create_booking(court=self.court_a, start_at=at(2, 18), end_at=at(2, 19), customer_name="Ali", customer_phone=PHONE)
        self.pay("2000", method="cash")
        with frozen(at(2, 23)):
            data = self.client.get(reverse("dashboard"), {"club": self.club_a.pk}).data
        this = data["this_month"]
        self.assertEqual(this["bookings"], 2)
        self.assertEqual(Decimal(this["revenue"]), Decimal("5000.00"))
        monday_10 = next(c for c in data["heatmap"]["cells"] if c["weekday"] == 0 and c["hour"] == 10)
        # One Monday in the window had 10:00-11:00 booked on the only court... out of 1 court x 1 Monday x 60 min.
        self.assertGreater(monday_10["occupancy"], 0)
        self.assertEqual(data["top_customers"][0]["name"], "Ali")
        self.assertEqual(len(data["months"]), 6)

    def test_receptionist_gets_403(self):
        self.assertEqual(self.client.get(reverse("dashboard"), {"club": self.club_a.pk}).status_code, 403)


@override_settings(TELEGRAM_BOT_TOKEN="test-token", TELEGRAM_BOT_USERNAME="padel_test_bot")
class PublicBookingTests(GrowthTestBase):
    def setUp(self):
        super().setUp()
        self.club_a.online_booking_enabled = True
        self.club_a.telegram_chat_id = "-100123"
        self.club_a.save()
        self.client.force_authenticate(None)
        self.sent = []
        patcher = mock.patch("notify.telegram.call", side_effect=lambda method, payload, timeout=10: self.sent.append(payload) or {"ok": True})
        patcher.start()
        self.addCleanup(patcher.stop)

    def book(self, start="2026-11-03T18:00:00+03:00", end="2026-11-03T19:30:00+03:00", phone="+7 911 000-11-22", **extra):
        body = {
            "court": self.court_a.pk,
            "start_at": start,
            "end_at": end,
            "customer_name": "Online Olga",
            "customer_phone": phone,
            "consent": True,
            **extra,
        }
        with frozen(at(2, 9)), self.captureOnCommitCallbacks(execute=True):
            return self.client.post(reverse("public-booking-create", args=[self.club_a.slug]), body, format="json")

    def test_disabled_club_is_not_found(self):
        self.club_a.online_booking_enabled = False
        self.club_a.save()
        self.assertEqual(self.client.get(reverse("public-club", args=[self.club_a.slug])).status_code, 404)

    def test_availability_hides_past_slots(self):
        with frozen(at(2, 10, 15)):
            data = self.client.get(reverse("public-availability", args=[self.club_a.slug]), {"date": "2026-11-02"}).data
        slots = {s["start"][11:16]: s["available"] for s in data["courts"][0]["slots"]}
        self.assertFalse(slots["10:30"] or slots["09:00"])
        self.assertTrue(slots["11:30"])

    def test_book_online_then_cancel(self):
        created = self.book()
        self.assertEqual(created.status_code, 201)
        booking = Booking.objects.get(public_token__isnull=False)
        self.assertEqual(booking.source, "online")
        self.assertTrue(created.data["telegram_link"].startswith("https://t.me/padel_test_bot?start="))
        token = created.data["token"]
        with frozen(at(2, 9)):
            cancelled = self.client.post(reverse("public-booking-cancel", args=[token]))
        self.assertEqual(cancelled.data["status"], "cancelled")

    def test_consent_and_phone_are_required(self):
        self.assertEqual(self.book(consent=False).status_code, 400)
        self.assertEqual(self.book(phone="12").status_code, 400)

    def test_too_late_to_cancel(self):
        token = self.book().data["token"]
        with frozen(at(3, 12)):
            response = self.client.post(reverse("public-booking-cancel", args=[token]))
        self.assertEqual(response.data["code"], "too_late_to_cancel")

    def test_limits(self):
        self.assertEqual(self.book(start="2026-12-30T10:00:00+03:00", end="2026-12-30T11:00:00+03:00").data["code"], "too_far_ahead")
        for hour in (10, 12, 14):
            self.book(start=f"2026-11-04T{hour}:00:00+03:00", end=f"2026-11-04T{hour + 1}:00:00+03:00")
        fourth = self.book(start="2026-11-04T16:00:00+03:00", end="2026-11-04T17:00:00+03:00")
        self.assertEqual(fourth.data["code"], "too_many_online")

    def test_staff_group_hears_about_it(self):
        self.book()
        self.assertTrue(any(p.get("chat_id") == "-100123" and "18:00" in p["text"] for p in self.sent))

    def test_bot_links_the_chat_and_reminders_go_out(self):
        token = self.book().data["token"]
        reply = handle_message({"chat": {"id": 777}, "text": f"/start {token}"})
        self.assertIn("18:00", reply)
        self.assertEqual(Customer.objects.get(phone="+79110001122").telegram_chat_id, "777")
        with frozen(at(3, 16, 30)):
            self.assertEqual(send_due_reminders(hours=2), 1)
            self.assertEqual(send_due_reminders(hours=2), 0)  # never twice

    def test_unknown_token_is_404(self):
        self.assertEqual(self.client.get(reverse("public-booking", args=["not-a-token"])).status_code, 404)


class SlugTests(ApiTestBase):
    def test_clubs_get_a_unique_slug(self):
        a, _ = make_club("Same Name")
        b, _ = make_club("Same Name")
        self.assertEqual((a.slug, b.slug), ("same-name", "same-name-2"))
