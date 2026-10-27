import json
from decimal import Decimal
from unittest import mock

from django.test import override_settings
from django.urls import reverse

from bookings.models import Booking, Payment, Refund
from notify.models import Notification
from payments.models import OnlinePayment

from .test_growth import GrowthTestBase, at, frozen

START, END = "2026-11-03T18:00:00+03:00", "2026-11-03T19:30:00+03:00"  # 90 minutes at 3000/h


@override_settings(PAYMENTS_DEMO=True, YOOKASSA_SHOP_ID="", YOOKASSA_SECRET_KEY="", TELEGRAM_BOT_TOKEN="")
class PrepaymentTestBase(GrowthTestBase):
    def setUp(self):
        super().setUp()
        self.club_a.online_booking_enabled = True
        self.club_a.save()
        self.client.force_authenticate(None)

    def book(self, start=START, end=END, now=None):
        body = {
            "court": self.court_a.pk,
            "start_at": start,
            "end_at": end,
            "customer_name": "Online Olga",
            "customer_phone": "+7 911 000-11-22",
            "consent": True,
        }
        with frozen(now or at(2, 9)):
            return self.client.post(reverse("public-booking-create", args=[self.club_a.slug]), body, format="json")

    def pay(self, booked, result="succeeded", now=None):
        payment_id = booked.data["payment_url"].rsplit("/", 1)[-1]
        with frozen(now or at(2, 9, 5)):
            return self.client.post(reverse("demo-payment", args=[payment_id]), {"result": result}, format="json")

    def view(self, booked, now=None):
        with frozen(now or at(2, 9, 5)):
            return self.client.get(reverse("public-booking", args=[booked.data["token"]])).data

    def free_at_18(self, now):
        with frozen(now):
            data = self.client.get(
                reverse("public-availability", args=[self.club_a.slug]), {"date": "2026-11-03", "minutes": 90}
            ).data
        return any(t["start"][11:16] == "18:00" for t in data["courts"][0]["times"])


class PrepaymentTests(PrepaymentTestBase):
    def test_the_court_is_only_held_until_the_prepayment(self):
        booked = self.book()
        self.assertEqual(booked.status_code, 201)
        self.assertTrue(booked.data["awaiting_payment"])
        self.assertTrue(booked.data["payment_url"].startswith("/pay/demo/"))
        self.assertEqual(Decimal(booked.data["prepay_amount"]), Decimal("4500.00"))
        self.assertFalse(self.free_at_18(at(2, 9, 5)))
        self.assertFalse(Notification.objects.exists())  # nothing to tell the staff before the money comes

    def test_paying_confirms_the_booking_and_tells_the_staff(self):
        booked = self.book()
        self.assertEqual(self.pay(booked).data["status"], "succeeded")
        booking = Booking.objects.get(public_token__isnull=False)
        self.assertIsNone(booking.hold_until)
        payment = Payment.objects.get(booking=booking)
        self.assertEqual((payment.method, payment.amount), ("online", Decimal("4500.00")))
        summary = self.view(booked)
        self.assertEqual((summary["awaiting_payment"], Decimal(summary["prepaid"])), (False, Decimal("4500.00")))
        notification = Notification.objects.get()
        self.assertEqual((notification.kind, notification.data["customer_name"]), ("online_booking", "Online Olga"))

    def test_an_unpaid_hold_runs_out_and_frees_the_court(self):
        booked = self.book()
        self.assertTrue(self.free_at_18(at(2, 9, 16)))
        self.assertEqual(Booking.objects.get(public_token__isnull=False).status, "cancelled")
        self.assertTrue(self.view(booked, now=at(2, 9, 17))["payment_missed"])

    def test_money_that_comes_after_the_hold_is_refunded(self):
        booked = self.book()
        self.free_at_18(at(2, 9, 16))
        self.pay(booked, now=at(2, 9, 18))
        payment = OnlinePayment.objects.get()
        self.assertEqual((payment.status, payment.refunded), ("succeeded", Decimal("4500.00")))
        self.assertFalse(Payment.objects.exists())
        self.assertEqual(Notification.objects.get().kind, "late_payment")

    def test_giving_up_on_paying_frees_the_court(self):
        booked = self.book()
        self.pay(booked, result="canceled")
        self.assertTrue(self.free_at_18(at(2, 9, 6)))

    def test_cancelling_a_paid_booking_refunds_the_prepayment(self):
        booked = self.book()
        self.pay(booked)
        with frozen(at(2, 9, 10)):
            data = self.client.post(reverse("public-booking-cancel", args=[booked.data["token"]])).data
        self.assertEqual((data["status"], Decimal(data["refunded"])), ("cancelled", Decimal("4500.00")))
        refund = Refund.objects.get()
        self.assertEqual((refund.method, refund.amount), ("online", Decimal("4500.00")))
        self.assertEqual(Notification.objects.latest("id").kind, "online_cancelled")

    def test_a_partial_prepayment(self):
        self.club_a.online_prepay_percent = 30
        self.club_a.save()
        booked = self.book()
        self.assertEqual(Decimal(booked.data["prepay_amount"]), Decimal("1350.00"))
        self.pay(booked)
        self.assertEqual(Payment.objects.get().amount, Decimal("1350.00"))

    def test_no_prepayment_when_the_club_does_not_ask_for_one(self):
        self.club_a.online_prepay_percent = 0
        self.club_a.save()
        booked = self.book()
        self.assertFalse(booked.data["awaiting_payment"])
        self.assertEqual(Notification.objects.get().kind, "online_booking")

    @override_settings(PAYMENTS_DEMO=False)
    def test_refused_when_no_payment_provider_is_set_up(self):
        self.assertEqual(self.book().data["code"], "payments_not_configured")
        self.assertFalse(Booking.objects.filter(public_token__isnull=False).exists())

    def test_paying_at_the_desk_keeps_the_booking(self):
        self.book()
        held = Booking.objects.get(public_token__isnull=False)
        self.client.force_authenticate(self.user_a)
        with frozen(at(2, 9, 5)):
            self.client.post(reverse("booking-payments", args=[held.pk]), {"amount": "4500", "method": "cash"}, format="json")
        self.assertFalse(self.free_at_18(at(2, 9, 30)))  # long after the hold would have run out
        held.refresh_from_db()
        self.assertEqual((held.status, held.hold_until), ("confirmed", None))

    def test_money_is_kept_on_the_bill_when_staff_lowered_the_price_meanwhile(self):
        booked = self.book()
        held = Booking.objects.get(public_token__isnull=False)
        self.client.force_authenticate(self.user_a)
        with frozen(at(2, 9, 2)):
            self.client.patch(reverse("booking-detail", args=[held.pk]), {"end_at": "2026-11-03T19:00:00+03:00"}, format="json")
        self.client.force_authenticate(None)
        self.pay(booked)
        self.assertEqual(Payment.objects.get().amount, Decimal("4500.00"))  # all of it, though the bill is now 3000
        self.assertEqual(OnlinePayment.objects.get().status, "succeeded")

    def test_staff_cannot_enter_online_payments_by_hand(self):
        self.client.force_authenticate(self.user_a)
        response = self.client.post(
            reverse("booking-payments", args=[self.booking.pk]), {"amount": "100", "method": "online"}, format="json"
        )
        self.assertEqual(response.status_code, 400)


class NotificationTests(PrepaymentTestBase):
    def test_unread_until_seen_and_only_for_the_club(self):
        self.pay(self.book())
        self.client.force_authenticate(self.user_a)
        url = reverse("notifications")
        with frozen(at(2, 9, 10)):
            data = self.client.get(url, {"club": self.club_a.pk}).data
            self.assertEqual(data["unread"], 1)
            self.assertEqual(data["items"][0]["data"]["court"], "Court 1")
            self.client.post(reverse("notifications-seen"), {"club": self.club_a.pk}, format="json")
            data = self.client.get(url, {"club": self.club_a.pk}).data
        self.assertEqual((data["unread"], data["items"][0]["unread"]), (0, False))
        self.client.force_authenticate(self.user_b)
        self.assertEqual(self.client.get(url, {"club": self.club_a.pk}).status_code, 404)


class FakeYooKassa:
    """Answers like the YooKassa API and remembers what it was asked."""

    def __init__(self):
        self.requests = []
        self.status = "pending"

    def __call__(self, request, timeout=None):
        self.requests.append(request)
        if request.full_url.endswith("/payments"):
            body = {"id": "yk-1", "status": "pending", "confirmation": {"confirmation_url": "https://yoomoney.ru/checkout/yk-1"}}
        else:
            body = {"id": "yk-1", "status": self.status}
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(body).encode()
        return response


@override_settings(YOOKASSA_SHOP_ID="123", YOOKASSA_SECRET_KEY="test_secret")
class YooKassaTests(PrepaymentTestBase):
    def setUp(self):
        super().setUp()
        self.yookassa = FakeYooKassa()
        patcher = mock.patch("payments.providers.urllib.request.urlopen", self.yookassa)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_pay_on_yookassa_and_hear_back_by_webhook(self):
        booked = self.book()
        self.assertEqual(booked.data["payment_url"], "https://yoomoney.ru/checkout/yk-1")
        sent = self.yookassa.requests[0]
        body = json.loads(sent.data)
        self.assertEqual(body["amount"], {"value": "4500.00", "currency": "RUB"})
        self.assertTrue(body["confirmation"]["return_url"].endswith(f"/b/{booked.data['token']}"))
        self.assertTrue(sent.get_header("Idempotence-key"))

        self.yookassa.status = "succeeded"
        with frozen(at(2, 9, 5)):
            response = self.client.post(
                reverse("yookassa-webhook"), {"event": "payment.succeeded", "object": {"id": "yk-1"}}, format="json"
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(Payment.objects.get().method, "online")
        self.assertEqual(self.yookassa.requests[-1].get_method(), "GET")  # the status was asked, not taken from the body

    def test_a_malformed_webhook_is_ignored(self):
        for body in ([1, 2], {"object": "x"}, {}):
            self.assertEqual(self.client.post(reverse("yookassa-webhook"), body, format="json").status_code, 200)
