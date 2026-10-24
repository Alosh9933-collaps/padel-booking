from datetime import datetime
from decimal import Decimal
from unittest import mock
from zoneinfo import ZoneInfo

from django.urls import reverse

from bookings.services import create_booking
from buffet.models import Product
from cashdesk.models import Activity, Shift
from clubs.models import Membership

from .test_api import DAY, ApiTestBase

MSK = ZoneInfo("Europe/Moscow")


def at(day, hour, minute=0):
    return datetime(2026, 11, day, hour, minute, tzinfo=MSK)


def frozen(moment):
    return mock.patch("django.utils.timezone.now", return_value=moment)


class CashdeskTestBase(ApiTestBase):
    def setUp(self):
        super().setUp()
        self.water = Product.objects.create(club=self.club_a, name="Water", price=Decimal("100"))
        self.bar = Product.objects.create(club=self.club_a, name="Bar", price=Decimal("250"))
        # 10:00-11:00 at 2000/h
        self.booking = create_booking(court=self.court_a, start_at=at(2, 10), end_at=at(2, 11), customer_name="Ali")

    def make_manager(self):
        Membership.objects.filter(user=self.user_a).update(role="manager")

    def pay(self, amount, method="cash"):
        return self.client.post(
            reverse("booking-payments", args=[self.booking.pk]), {"amount": amount, "method": method}, format="json"
        )

    def refund(self, amount, method="cash"):
        return self.client.post(
            reverse("booking-refunds", args=[self.booking.pk]),
            {"amount": amount, "method": method, "reason": "test"},
            format="json",
        )

    def sell(self, lines, method="cash", club=None):
        return self.client.post(
            reverse("sale-list"),
            {
                "club": (club or self.club_a).pk,
                "items": [{"product": p.pk, "quantity": q} for p, q in lines],
                "method": method,
            },
            format="json",
        )


class RefundTests(CashdeskTestBase):
    def test_refund_after_cancellation(self):
        self.pay("2000")
        self.client.post(reverse("booking-cancel", args=[self.booking.pk]))
        bill = self.client.get(reverse("booking-detail", args=[self.booking.pk])).data
        self.assertEqual(Decimal(bill["refundable"]), Decimal("2000.00"))
        data = self.refund("2000").data
        self.assertEqual(Decimal(data["refundable"]), Decimal("0.00"))
        self.assertEqual(Decimal(data["paid_total"]), Decimal("0.00"))
        self.assertEqual(len(data["refunds"]), 1)

    def test_refund_overpayment_after_discount(self):
        self.pay("2000")
        data = self.client.post(
            reverse("booking-discount", args=[self.booking.pk]), {"kind": "manual", "amount": "500"}, format="json"
        ).data
        self.assertEqual(Decimal(data["refundable"]), Decimal("500.00"))
        self.assertEqual(self.refund("600").data["code"], "refund_too_much")
        self.assertEqual(self.refund("500").data["payment_status"], "paid")

    def test_nothing_to_refund_on_an_unpaid_bill(self):
        self.assertEqual(self.refund("100").data["code"], "refund_too_much")


class SaleTests(CashdeskTestBase):
    def test_counter_sale(self):
        response = self.sell([(self.water, 2), (self.bar, 1), (self.water, 1)])
        self.assertEqual(response.status_code, 201)
        self.assertEqual(Decimal(response.data["total"]), Decimal("550.00"))
        self.assertEqual({i["name"]: i["quantity"] for i in response.data["items"]}, {"Water": 3, "Bar": 1})

    def test_product_of_another_club_is_rejected(self):
        foreign = Product.objects.create(club=self.club_b, name="Cola", price=Decimal("150"))
        self.assertEqual(self.sell([(foreign, 1)]).data["code"], "product_unavailable")

    def test_cannot_sell_in_another_club(self):
        self.assertEqual(self.sell([(self.water, 1)], club=self.club_b).status_code, 400)

    def test_void(self):
        sale_id = self.sell([(self.water, 1)]).data["id"]
        url = reverse("sale-void", args=[sale_id])
        self.assertIsNotNone(self.client.post(url, {"reason": "wrong item"}, format="json").data["voided_at"])
        self.assertEqual(self.client.post(url, {}, format="json").data["code"], "sale_voided")

    def test_daily_report_counts_sales_and_refunds(self):
        with frozen(at(2, 12)):
            self.pay("2000", "cash")
            self.sell([(self.water, 3)], "card")
            self.client.post(
                reverse("booking-discount", args=[self.booking.pk]), {"kind": "manual", "amount": "200"}, format="json"
            )
            self.refund("200", "cash")
        data = self.client.get(reverse("daily-report"), {"club": self.club_a.pk, "date": DAY}).data
        totals = {m["method"]: Decimal(m["total"]) for m in data["by_method"]}
        self.assertEqual(totals["cash"], Decimal("1800.00"))
        self.assertEqual(totals["card"], Decimal("300.00"))
        self.assertEqual(Decimal(data["received"]), Decimal("2100.00"))
        self.assertEqual(Decimal(data["refunds_total"]), Decimal("200.00"))
        self.assertEqual(Decimal(data["sales_total"]), Decimal("300.00"))
        self.assertEqual(data["buffet"][0]["name"], "Water")

    def test_revenue_report_counts_sales_as_buffet(self):
        self.make_manager()
        with frozen(at(3, 12)):
            self.sell([(self.bar, 2)])
        data = self.client.get(
            reverse("revenue-report"), {"club": self.club_a.pk, "from": "2026-11-02", "to": "2026-11-03"}
        ).data
        self.assertEqual(Decimal(data["buffet_total"]), Decimal("500.00"))
        self.assertEqual([d["date"] for d in data["by_day"]], ["2026-11-02", "2026-11-03"])


class ShiftTests(CashdeskTestBase):
    def test_open_and_close_with_difference(self):
        with frozen(at(2, 9)):
            opened = self.client.post(reverse("shift-open"), {"club": self.club_a.pk, "opening_cash": "1000"}, format="json")
        self.assertEqual(opened.status_code, 201)
        with frozen(at(2, 12)):
            self.pay("2000", "cash")
            self.pay("0.01", "card")  # card money never reaches the drawer
            self.sell([(self.water, 5)], "cash")
            current = self.client.get(reverse("shift-current"), {"club": self.club_a.pk}).data
        self.assertEqual(Decimal(current["expected"]), Decimal("3500.00"))
        with frozen(at(2, 22)):
            closed = self.client.post(
                reverse("shift-close", args=[opened.data["id"]]), {"counted_cash": "3400", "note": "short"}, format="json"
            ).data
        self.assertEqual(Decimal(closed["difference"]), Decimal("-100.00"))
        self.assertEqual(self.client.get(reverse("shift-current"), {"club": self.club_a.pk}).status_code, 204)

    def test_only_one_open_shift(self):
        self.client.post(reverse("shift-open"), {"club": self.club_a.pk, "opening_cash": "0"}, format="json")
        again = self.client.post(reverse("shift-open"), {"club": self.club_a.pk, "opening_cash": "0"}, format="json")
        self.assertEqual(again.data["code"], "shift_already_open")
        self.assertEqual(Shift.objects.count(), 1)

    def test_history_is_for_managers(self):
        self.client.post(reverse("shift-open"), {"club": self.club_a.pk, "opening_cash": "0"}, format="json")
        self.assertEqual(self.client.get(reverse("shift-list")).data, [])
        self.make_manager()
        self.assertEqual(len(self.client.get(reverse("shift-list")).data), 1)


class ActivityTests(CashdeskTestBase):
    def test_money_actions_are_logged_with_the_user(self):
        self.pay("1000")
        self.client.post(reverse("booking-discount", args=[self.booking.pk]), {"kind": "manual", "percent": "10"}, format="json")
        self.client.post(reverse("booking-cancel", args=[self.booking.pk]))
        actions = list(Activity.objects.order_by("created_at").values_list("action", "user__username"))
        self.assertEqual(
            actions,
            [("payment.added", "user_a"), ("discount.applied", "user_a"), ("booking.cancelled", "user_a")],
        )

    def test_only_managers_read_the_log(self):
        self.pay("1000")
        self.assertEqual(self.client.get(reverse("activity-list")).data, [])
        self.make_manager()
        data = self.client.get(reverse("activity-list"), {"booking": self.booking.pk}).data
        self.assertEqual([a["action"] for a in data], ["payment.added"])
        self.assertEqual(data[0]["data"]["customer"], "Ali")

    def test_other_clubs_log_is_invisible(self):
        self.make_manager()
        other = create_booking(court=self.court_b, start_at=at(2, 10), end_at=at(2, 11), customer_name="X")
        Activity.objects.create(club=self.club_b, action="booking.created", booking=other)
        self.assertEqual(self.client.get(reverse("activity-list")).data, [])
