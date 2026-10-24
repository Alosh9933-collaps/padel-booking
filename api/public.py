"""Online booking for customers: no login, one public page per club.

A club opts in (online_booking_enabled). Customers see free times, book with
their name and phone, pay the club's prepayment, and get a private link to view
or cancel the booking. Until the prepayment arrives the court is only held for
a few minutes. The pages are throttled per IP, and one phone can hold only a
few upcoming online bookings, so the public page cannot block a club's courts.
"""

import uuid
from datetime import date as date_type
from datetime import timedelta
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import transaction
from django.http import Http404
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import serializers, status
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from bookings.availability import free_starts
from bookings.models import Booking
from bookings.services import BookingError, cancel_booking, create_booking
from cashdesk.services import record
from clubs.models import Club, Court, normalize_phone
from notify import telegram
from notify.models import Notification
from notify.staff import announce
from payments import services as prepay
from payments.models import OnlinePayment

MAX_UPCOMING_PER_PHONE = 3
# Customers choose any length: at least an hour, in steps of 10 minutes, starting on a 10-minute mark.
MIN_MINUTES = 60
MAX_MINUTES = 240
STEP_MINUTES = 10


def _check_length(minutes):
    if not MIN_MINUTES <= minutes <= MAX_MINUTES or minutes % STEP_MINUTES:
        raise BookingError(
            f"Choose from {MIN_MINUTES} to {MAX_MINUTES} minutes, in steps of {STEP_MINUTES}.", "bad_online_length"
        )


class PublicView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "public"

    def club(self, slug):
        return get_object_or_404(Club, slug=slug, online_booking_enabled=True)


def _today(club):
    return timezone.now().astimezone(ZoneInfo(club.timezone)).date()


def _summary(booking):
    club = booking.court.club
    cancel_until = booking.start_at - timedelta(hours=club.online_cancel_hours)
    payments = list(booking.online_payments.order_by("created_at"))
    pending = next((p for p in reversed(payments) if p.status == OnlinePayment.Status.PENDING), None)
    awaiting = booking.status == Booking.Status.CONFIRMED and booking.hold_until is not None
    return {
        "token": booking.public_token.hex,
        "club": club.name,
        "club_slug": club.slug,
        "timezone": club.timezone,
        "currency": club.currency,
        "court": booking.court.name,
        "customer_name": booking.customer_name,
        "start_at": booking.start_at,
        "end_at": booking.end_at,
        "price": f"{booking.price:.2f}",
        "status": booking.status,
        "cancel_until": cancel_until,
        "can_cancel": booking.status == Booking.Status.CONFIRMED and timezone.now() <= cancel_until,
        "telegram_link": None if awaiting else telegram.start_link(booking),
        # Prepayment: while awaiting it the court is held until hold_until, and payment_url is where to pay.
        "awaiting_payment": awaiting,
        "hold_until": booking.hold_until if awaiting else None,
        "payment_url": pending.confirmation_url if awaiting and pending else None,
        "prepay_amount": f"{pending.amount:.2f}" if awaiting and pending else None,
        "prepaid": f"{sum(p.amount - p.refunded for p in payments if p.status == OnlinePayment.Status.SUCCEEDED):.2f}",
        "refunded": f"{sum(p.refunded for p in payments):.2f}",
        # The hold ran out, or the customer gave up on paying.
        "payment_missed": booking.status == Booking.Status.CANCELLED and bool(payments)
        and not any(p.status == OnlinePayment.Status.SUCCEEDED for p in payments),
    }


def _sync(booking):
    """Before showing a booking, catch up with its payment and with holds that ran out."""
    for payment in booking.online_payments.filter(status=OnlinePayment.Status.PENDING):
        try:
            prepay.sync(payment)
        except BookingError:
            pass  # the provider is not answering; show what we know
    prepay.release_expired_holds()
    booking.refresh_from_db()
    return booking


SUMMARY = inline_serializer(
    "PublicBooking",
    {
        "token": serializers.CharField(),
        "club": serializers.CharField(),
        "court": serializers.CharField(),
        "start_at": serializers.DateTimeField(),
        "end_at": serializers.DateTimeField(),
        "price": serializers.DecimalField(max_digits=10, decimal_places=2),
        "status": serializers.CharField(),
        "can_cancel": serializers.BooleanField(),
        "cancel_until": serializers.DateTimeField(),
        "telegram_link": serializers.CharField(allow_null=True),
        "awaiting_payment": serializers.BooleanField(),
        "hold_until": serializers.DateTimeField(allow_null=True),
        "payment_url": serializers.CharField(allow_null=True),
        "prepay_amount": serializers.DecimalField(max_digits=10, decimal_places=2, allow_null=True),
        "prepaid": serializers.DecimalField(max_digits=10, decimal_places=2),
        "refunded": serializers.DecimalField(max_digits=10, decimal_places=2),
        "payment_missed": serializers.BooleanField(),
    },
)


class PublicClubView(PublicView):
    @extend_schema(
        responses=inline_serializer(
            "PublicClub",
            {
                "name": serializers.CharField(),
                "slug": serializers.CharField(),
                "timezone": serializers.CharField(),
                "currency": serializers.CharField(),
                "min_minutes": serializers.IntegerField(),
                "max_minutes": serializers.IntegerField(),
                "step_minutes": serializers.IntegerField(),
                "prepay_percent": serializers.IntegerField(),
                "hold_minutes": serializers.IntegerField(),
                "days_ahead": serializers.IntegerField(),
                "cancel_hours": serializers.IntegerField(),
                "courts": serializers.ListField(child=serializers.DictField()),
            },
        )
    )
    def get(self, request, slug):
        club = self.club(slug)
        return Response({
            "name": club.name,
            "slug": club.slug,
            "timezone": club.timezone,
            "currency": club.currency,
            "opening_hour": club.opening_hour,
            "closing_hour": club.closing_hour,
            "slot_minutes": club.slot_minutes,
            "min_minutes": MIN_MINUTES,
            "max_minutes": MAX_MINUTES,
            "step_minutes": STEP_MINUTES,
            "prepay_percent": club.online_prepay_percent,
            "hold_minutes": prepay.HOLD_MINUTES,
            "days_ahead": club.online_days_ahead,
            "cancel_hours": club.online_cancel_hours,
            "today": _today(club),
            "courts": [
                {"id": c.id, "name": c.name, "kind": c.kind}
                for c in club.courts.filter(is_active=True).order_by("name")
            ],
        })


class PublicAvailabilityView(PublicView):
    @extend_schema(
        parameters=[
            OpenApiParameter("date", str, required=True, description="YYYY-MM-DD"),
            OpenApiParameter("minutes", int, description=f"Length of the game, {MIN_MINUTES}-{MAX_MINUTES} in steps of {STEP_MINUTES}"),
        ],
        responses=inline_serializer(
            "PublicAvailability",
            {
                "date": serializers.DateField(),
                "minutes": serializers.IntegerField(),
                "courts": serializers.ListField(child=serializers.DictField()),
            },
        ),
    )
    def get(self, request, slug):
        club = self.club(slug)
        try:
            day = date_type.fromisoformat(request.query_params.get("date", ""))
        except ValueError:
            raise ValidationError({"date": "Use the format YYYY-MM-DD."})
        try:
            minutes = int(request.query_params.get("minutes", "90"))
        except ValueError:
            raise ValidationError({"minutes": "Send a whole number of minutes."})
        _check_length(minutes)
        today = _today(club)
        if not today <= day <= today + timedelta(days=club.online_days_ahead):
            raise ValidationError({"date": "This day is not open for online booking."})
        prepay.release_expired_holds()
        now = timezone.now()
        courts = []
        for court in club.courts.filter(is_active=True).select_related("club").order_by("name"):
            # Times that already started are not offered online.
            times = [
                {"start": s["start"].isoformat(), "end": s["end"].isoformat(), "price": f"{s['price']:.2f}"}
                for s in free_starts(court, day, minutes, not_before=now, mark=STEP_MINUTES)
            ]
            courts.append({"id": court.id, "name": court.name, "kind": court.kind, "times": times})
        return Response({"date": day, "minutes": minutes, "courts": courts})


class PublicBookingCreateSerializer(serializers.Serializer):
    court = serializers.IntegerField()
    start_at = serializers.DateTimeField()
    end_at = serializers.DateTimeField()
    customer_name = serializers.CharField(max_length=120)
    customer_phone = serializers.CharField(max_length=32)
    consent = serializers.BooleanField()

    def validate_consent(self, value):
        if not value:
            raise serializers.ValidationError("Please agree to the processing of your name and phone.")
        return value

    def validate_customer_phone(self, value):
        if len(normalize_phone(value).lstrip("+")) < 7:
            raise serializers.ValidationError("Enter a phone number.")
        return value


class PublicBookingCreateView(PublicView):
    throttle_scope = "public_booking"

    @extend_schema(request=PublicBookingCreateSerializer, responses={201: SUMMARY})
    def post(self, request, slug):
        club = self.club(slug)
        serializer = PublicBookingCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        court = get_object_or_404(Court, pk=data["court"], club=club, is_active=True)

        seconds = (data["end_at"] - data["start_at"]).total_seconds()
        _check_length(int(seconds // 60) if seconds % 60 == 0 else 0)
        local_start = data["start_at"].astimezone(ZoneInfo(club.timezone))
        if local_start.minute % STEP_MINUTES or local_start.second or local_start.microsecond:
            raise BookingError(f"Start on a {STEP_MINUTES}-minute mark, like 18:00 or 18:10.", "bad_online_start")
        now = timezone.now()
        if data["start_at"] <= now:
            raise BookingError("This time has already passed.", "in_the_past")
        last_day = _today(club) + timedelta(days=club.online_days_ahead)
        if data["start_at"].astimezone(ZoneInfo(club.timezone)).date() > last_day:
            raise BookingError("This day is not open for online booking yet.", "too_far_ahead")
        prepay.provider_for(club)  # refuse early when the club wants a prepayment it cannot take
        prepay.release_expired_holds()  # holds that ran out neither block the court nor count below
        phone = normalize_phone(data["customer_phone"])
        upcoming = Booking.objects.filter(
            court__club=club,
            source=Booking.Source.ONLINE,
            status=Booking.Status.CONFIRMED,
            start_at__gt=now,
            customer__phone=phone,
        ).count()
        if upcoming >= MAX_UPCOMING_PER_PHONE:
            raise BookingError("This phone already has the most online bookings allowed.", "too_many_online")

        with transaction.atomic():
            booking = create_booking(
                court=court,
                start_at=data["start_at"],
                end_at=data["end_at"],
                customer_name=data["customer_name"].strip(),
                customer_phone=data["customer_phone"].strip(),
            )
            booking.source = Booking.Source.ONLINE
            booking.public_token = uuid.uuid4()
            # Until the prepayment comes in, the court is only held for a few minutes.
            needs_payment = prepay.prepay_amount(booking) > 0
            booking.hold_until = prepay.hold_until() if needs_payment else None
            booking.save(update_fields=["source", "public_token", "hold_until"])
            record(
                club,
                None,
                "booking.created",
                booking=booking,
                amount=booking.price,
                customer=booking.customer_name,
                court=court.name,
                start=booking.start_at.isoformat(),
                end=booking.end_at.isoformat(),
                online=True,
            )
            if not needs_payment:
                announce(booking, Notification.Kind.ONLINE_BOOKING)
        if needs_payment:
            site = settings.PUBLIC_SITE_URL or request.build_absolute_uri("/").rstrip("/")
            try:
                prepay.start(booking, return_url=f"{site}/b/{booking.public_token.hex}")
            except BookingError:
                cancel_booking(booking)  # no payment page, so no hold either
                raise
        return Response(_summary(booking), status=status.HTTP_201_CREATED)


def _by_token(token):
    try:
        value = uuid.UUID(token)
    except ValueError:
        # Never fall through to public_token=None: that would match staff bookings.
        raise Http404
    return get_object_or_404(
        Booking.objects.select_related("court__club"), public_token=value, court__club__online_booking_enabled=True
    )


class PublicBookingView(PublicView):
    @extend_schema(responses=SUMMARY)
    def get(self, request, token):
        return Response(_summary(_sync(_by_token(token))))


class PublicBookingCancelView(PublicView):
    """Cancel a booking. A paid one only within the club's window, and the prepayment goes back."""

    @extend_schema(request=None, responses=SUMMARY)
    def post(self, request, token):
        booking = _sync(_by_token(token))
        summary = _summary(booking)
        if booking.status != Booking.Status.CONFIRMED:
            raise BookingError("This booking is not active.", "booking_closed")
        # Giving up before paying is always fine: it only ends the hold.
        unpaid_hold = summary["awaiting_payment"]
        if not unpaid_hold and not summary["can_cancel"]:
            raise BookingError("It is too late to cancel online. Please call the club.", "too_late_to_cancel")
        with transaction.atomic():
            cancel_booking(booking)
            prepay.refund_to_customer(booking, "Cancelled online by the customer")
            record(
                booking.court.club,
                None,
                "booking.cancelled",
                booking=booking,
                customer=booking.customer_name,
                court=booking.court.name,
                start=booking.start_at.isoformat(),
                online=True,
            )
            if not unpaid_hold:
                announce(booking, Notification.Kind.ONLINE_CANCELLED)
        return Response(_summary(booking))


def _demo_payment(payment_id):
    try:
        value = uuid.UUID(str(payment_id))
    except ValueError:
        raise Http404
    if not settings.PAYMENTS_DEMO:
        raise Http404
    return get_object_or_404(OnlinePayment.objects.select_related("booking__court__club"), pk=value, provider="demo")


DEMO_PAYMENT = inline_serializer(
    "DemoPayment",
    {
        "id": serializers.UUIDField(),
        "amount": serializers.DecimalField(max_digits=10, decimal_places=2),
        "currency": serializers.CharField(),
        "club": serializers.CharField(),
        "status": serializers.CharField(),
        "return_url": serializers.CharField(),
    },
)


def _demo_details(payment):
    booking = payment.booking
    return {
        "id": payment.id,
        "amount": f"{payment.amount:.2f}",
        "currency": booking.court.club.currency,
        "club": booking.court.club.name,
        "status": payment.status,
        "return_url": f"/b/{booking.public_token.hex}",
    }


class DemoPaymentView(PublicView):
    """The demo provider's payment page (testing only: PAYMENTS_DEMO). No money moves."""

    @extend_schema(responses=DEMO_PAYMENT)
    def get(self, request, payment_id):
        return Response(_demo_details(_demo_payment(payment_id)))

    @extend_schema(
        request=inline_serializer("DemoPaymentResult", {"result": serializers.ChoiceField(choices=["succeeded", "canceled"])}),
        responses=DEMO_PAYMENT,
    )
    def post(self, request, payment_id):
        payment = _demo_payment(payment_id)
        result = request.data.get("result")
        if result not in ("succeeded", "canceled"):
            raise ValidationError({"result": "Send succeeded or canceled."})
        prepay.release_expired_holds()  # paying after the hold ran out gets refunded, as with a real provider
        payment = prepay.succeeded(payment) if result == "succeeded" else prepay.canceled(payment)
        return Response(_demo_details(payment))


class YooKassaWebhookView(PublicView):
    """YooKassa reports payment events here. The body is only a hint: the status is always asked from YooKassa."""

    throttle_classes = []

    @extend_schema(request=None, responses={200: None})
    def post(self, request):
        provider_id = (request.data.get("object") or {}).get("id", "")
        payment = OnlinePayment.objects.filter(provider="yookassa", provider_id=str(provider_id)).first()
        if payment is not None:
            try:
                prepay.sync(payment)
            except BookingError:
                return Response(status=status.HTTP_503_SERVICE_UNAVAILABLE)  # YooKassa will try again
        return Response(status=status.HTTP_200_OK)
