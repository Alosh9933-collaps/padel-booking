"""Online booking for customers: no login, one public page per club.

A club opts in (online_booking_enabled). Customers see free slots, book with
their name and phone, and get a private link to view or cancel the booking.
The pages are throttled per IP, and one phone can hold only a few upcoming
online bookings, so the public page cannot be used to block a club's courts.
"""

import uuid
from datetime import date as date_type
from datetime import timedelta
from zoneinfo import ZoneInfo

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

from bookings.availability import get_availability
from bookings.models import Booking
from bookings.services import BookingError, cancel_booking, create_booking
from cashdesk.services import record
from clubs.models import Club, Court, normalize_phone
from notify import telegram

MAX_UPCOMING_PER_PHONE = 3


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
        "telegram_link": telegram.start_link(booking),
    }


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
        parameters=[OpenApiParameter("date", str, required=True, description="YYYY-MM-DD")],
        responses=inline_serializer(
            "PublicAvailability",
            {"date": serializers.DateField(), "courts": serializers.ListField(child=serializers.DictField())},
        ),
    )
    def get(self, request, slug):
        club = self.club(slug)
        try:
            day = date_type.fromisoformat(request.query_params.get("date", ""))
        except ValueError:
            raise ValidationError({"date": "Use the format YYYY-MM-DD."})
        today = _today(club)
        if not today <= day <= today + timedelta(days=club.online_days_ahead):
            raise ValidationError({"date": "This day is not open for online booking."})
        now = timezone.now()
        courts = []
        for court in club.courts.filter(is_active=True).select_related("club").order_by("name"):
            slots = [
                {
                    "start": s["start"].isoformat(),
                    "end": s["end"].isoformat(),
                    # Slots that already started are not offered online.
                    "available": s["available"] and s["start"] > now,
                    "price": s["price"],
                }
                for s in get_availability(court, day)
            ]
            courts.append({"id": court.id, "name": court.name, "kind": court.kind, "slots": slots})
        return Response({"date": day, "courts": courts})


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

        now = timezone.now()
        if data["start_at"] <= now:
            raise BookingError("This time has already passed.", "in_the_past")
        last_day = _today(club) + timedelta(days=club.online_days_ahead)
        if data["start_at"].astimezone(ZoneInfo(club.timezone)).date() > last_day:
            raise BookingError("This day is not open for online booking yet.", "too_far_ahead")
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
            booking.save(update_fields=["source", "public_token"])
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
            telegram.notify_staff(booking, "staff_new")
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
        return Response(_summary(_by_token(token)))


class PublicBookingCancelView(PublicView):
    @extend_schema(request=None, responses=SUMMARY)
    def post(self, request, token):
        booking = _by_token(token)
        summary = _summary(booking)
        if booking.status != Booking.Status.CONFIRMED:
            raise BookingError("This booking is not active.", "booking_closed")
        if not summary["can_cancel"]:
            raise BookingError("It is too late to cancel online. Please call the club.", "too_late_to_cancel")
        with transaction.atomic():
            cancel_booking(booking)
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
            telegram.notify_staff(booking, "staff_cancelled")
        return Response(_summary(booking))
