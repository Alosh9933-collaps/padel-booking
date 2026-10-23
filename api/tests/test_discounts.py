from datetime import datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.urls import reverse

from bookings.models import Booking
from bookings.services import cancel_booking, change_booking, create_booking
from buffet.models import Product
from clubs.models import CustomerCategory, DiscountSettings, Membership

from .test_api import ApiTestBase

MSK = ZoneInfo("Europe/Moscow")
PHONE = "+7 900 123-45-67"


def at(day, hour, minute=0):
    return datetime(2026, 11, day, hour, minute, tzinfo=MSK)


class DiscountTestBase(ApiTestBase):
    def setUp(self):
        super().setUp()
        self.water = Product.objects.create(club=self.club_a, name="Water", price=Decimal("100"))
        self.rules = DiscountSettings.objects.create(
            club=self.club_a,
            first_visit_enabled=True,
            first_visit_percent=25,
            nth_visit_enabled=True,
            nth_visit_every=3,
            nth_visit_percent=100,
        )

    def book(self, day, hour=10, phone=PHONE):
        # 10:00-11:00 at 2000/h
        return create_booking(
            court=self.court_a, start_at=at(day, hour), end_at=at(day, hour + 1), customer_name="Ali", customer_phone=phone
        )

    def bill(self, booking):
        return self.client.get(reverse("booking-detail", args=[booking.pk])).data

    def discount(self, booking, **data):
        return self.client.post(reverse("booking-discount", args=[booking.pk]), data, format="json")


class OfferTests(DiscountTestBase):
    def test_first_visit_offer(self):
        first = self.book(2)
        offers = self.bill(first)["offers"]
        self.assertEqual([(o["kind"], o["percent"]) for o in offers], [("first_visit", 25)])
        self.assertEqual(Decimal(offers[0]["amount"]), Decimal("500.00"))
        self.assertEqual(self.bill(self.book(3))["offers"], [])

    def test_every_nth_visit_is_offered(self):
        bookings = [self.book(day) for day in (2, 3, 4, 5, 6, 7)]
        kinds = [[o["kind"] for o in self.bill(b)["offers"]] for b in bookings]
        self.assertEqual(kinds, [["first_visit"], [], ["nth_visit"], [], [], ["nth_visit"]])

    def test_cancelled_bookings_do_not_count_as_visits(self):
        cancel_booking(self.book(2))
        self.assertEqual(self.bill(self.book(3))["offers"][0]["kind"], "first_visit")

    def test_disabled_rules_offer_nothing(self):
        self.rules.first_visit_enabled = False
        self.rules.save()
        self.assertEqual(self.bill(self.book(2))["offers"], [])

    def test_category_offer(self):
        vip = CustomerCategory.objects.create(club=self.club_a, name="VIP", discount_percent=15)
        self.book(1)
        booking = self.book(2)
        booking.customer.category = vip
        booking.customer.save()
        offers = self.bill(booking)["offers"]
        self.assertEqual([(o["kind"], o["note"]) for o in offers], [("category", "VIP")])

    def test_no_phone_no_offers(self):
        booking = self.book(2, phone="")
        self.assertEqual(self.bill(booking)["offers"], [])


class ApplyTests(DiscountTestBase):
    def test_apply_offer_on_court_time_only(self):
        booking = self.book(2)
        self.client.post(reverse("booking-items", args=[booking.pk]), {"product": self.water.pk, "quantity": 2}, format="json")
        data = self.discount(booking, kind="first_visit").data
        self.assertEqual(data["discount_kind"], "first_visit")
        self.assertEqual(Decimal(data["discount"]), Decimal("500.00"))
        # 2000 + 200 - 500
        self.assertEqual(Decimal(data["total"]), Decimal("1700.00"))

    def test_offer_the_booking_does_not_qualify_for_is_rejected(self):
        self.book(2)
        response = self.discount(self.book(3), kind="first_visit")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["code"], "offer_not_available")

    def test_manual_percent_of_whole_bill_follows_item_changes(self):
        booking = self.book(2)
        self.discount(booking, kind="manual", percent="10", scope="total", note="Friend")
        data = self.client.post(
            reverse("booking-items", args=[booking.pk]), {"product": self.water.pk, "quantity": 10}, format="json"
        ).data
        # 10% of (2000 + 1000)
        self.assertEqual(Decimal(data["discount"]), Decimal("300.00"))
        self.assertEqual(Decimal(data["total"]), Decimal("2700.00"))

    def test_manual_amount_is_capped_at_the_bill(self):
        booking = self.book(2)
        data = self.discount(booking, kind="manual", amount="5000").data
        self.assertEqual(Decimal(data["discount"]), Decimal("2000.00"))
        self.assertEqual(data["payment_status"], "paid")

    def test_receptionist_can_give_a_manual_discount(self):
        self.assertEqual(Membership.objects.get(user=self.user_a).role, "receptionist")
        response = self.discount(self.book(2), kind="manual", percent="50", scope="court")
        self.assertEqual(Decimal(response.data["discount"]), Decimal("1000.00"))

    def test_bad_manual_discounts(self):
        booking = self.book(2)
        self.assertEqual(self.discount(booking, kind="manual").data["code"], "bad_discount")
        self.assertEqual(self.discount(booking, kind="manual", percent="150").data["code"], "bad_discount")
        self.assertEqual(self.discount(booking, kind="manual", percent="10", amount="10").data["code"], "bad_discount")

    def test_remove_discount(self):
        booking = self.book(2)
        self.discount(booking, kind="manual", percent="20")
        data = self.client.delete(reverse("booking-discount", args=[booking.pk])).data
        self.assertEqual((data["discount_kind"], Decimal(data["discount"])), ("", Decimal("0.00")))

    def test_changing_the_time_recalculates_a_percent_discount(self):
        booking = self.book(2)
        self.discount(booking, kind="first_visit")
        booking.refresh_from_db()
        change_booking(booking, end_at=booking.end_at + timedelta(hours=1))
        booking.refresh_from_db()
        # 25% of 4000
        self.assertEqual(booking.discount, Decimal("1000.00"))

    def test_payment_respects_the_discount(self):
        booking = self.book(2)
        self.discount(booking, kind="manual", percent="50", scope="court")
        url = reverse("booking-payments", args=[booking.pk])
        self.assertEqual(self.client.post(url, {"amount": "1500", "method": "cash"}, format="json").data["code"], "overpayment")
        self.assertEqual(self.client.post(url, {"amount": "1000", "method": "cash"}, format="json").data["payment_status"], "paid")


class SettingsAndCategoryTests(DiscountTestBase):
    def test_only_managers_change_rules(self):
        url = reverse("club-discounts", args=[self.club_a.pk])
        self.assertEqual(self.client.get(url).data["nth_visit_every"], 3)
        self.assertEqual(self.client.patch(url, {"nth_visit_every": 10}, format="json").status_code, 403)
        Membership.objects.filter(user=self.user_a).update(role="manager")
        self.assertEqual(self.client.patch(url, {"nth_visit_every": 10}, format="json").data["nth_visit_every"], 10)

    def test_categories_and_filter(self):
        Membership.objects.filter(user=self.user_a).update(role="manager")
        created = self.client.post(
            reverse("customercategory-list"),
            {"club": self.club_a.pk, "name": "Regular", "color": "#2f9a6a", "discount_percent": 10},
            format="json",
        )
        self.assertEqual(created.status_code, 201)
        booking = self.book(2)
        self.client.patch(
            reverse("customer-detail", args=[booking.customer_id]), {"category": created.data["id"]}, format="json"
        )
        listed = self.client.get(reverse("customer-list"), {"category": created.data["id"]}).data
        listed = listed["results"] if "results" in listed else listed
        self.assertEqual([(c["name"], c["category_name"]) for c in listed], [("Ali", "Regular")])

    def test_category_of_another_club_is_rejected(self):
        other = CustomerCategory.objects.create(club=self.club_b, name="Theirs")
        booking = self.book(2)
        response = self.client.patch(
            reverse("customer-detail", args=[booking.customer_id]), {"category": other.pk}, format="json"
        )
        self.assertEqual(response.status_code, 400)

    def test_revenue_report_subtracts_discounts(self):
        Membership.objects.filter(user=self.user_a).update(role="owner")
        booking = self.book(2)
        self.discount(booking, kind="first_visit")
        data = self.client.get(
            reverse("revenue-report"), {"club": self.club_a.pk, "from": "2026-11-02", "to": "2026-11-02"}
        ).data
        self.assertEqual(Decimal(data["discount_total"]), Decimal("500.00"))
        self.assertEqual(Decimal(data["grand_total"]), Decimal("1500.00"))
        self.assertEqual(Booking.objects.get().discount, Decimal("500.00"))
