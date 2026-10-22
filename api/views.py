from datetime import date as date_type
from zoneinfo import ZoneInfo

from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from bookings.availability import get_availability
from bookings.models import Booking
from bookings.services import BookingError, SlotUnavailable, cancel_booking, create_booking
from clubs.access import clubs_of
from clubs.models import Court

from .serializers import (
    AvailabilitySerializer,
    BookingCreateSerializer,
    BookingSerializer,
    CourtSerializer,
)


def parse_date(raw, field="date"):
    try:
        return date_type.fromisoformat(raw)
    except ValueError:
        raise ValidationError({field: "Use the format YYYY-MM-DD."})


class CourtViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    serializer_class = CourtSerializer

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Court.objects.none()
        return (
            Court.objects.filter(club__in=clubs_of(self.request.user))
            .select_related("club")
            .order_by("club_id", "name")
        )

    @extend_schema(
        parameters=[
            OpenApiParameter(
                "date", str, description="YYYY-MM-DD in the club's timezone. Defaults to today."
            )
        ],
        responses=AvailabilitySerializer,
    )
    @action(detail=True, methods=["get"])
    def availability(self, request, pk=None):
        court = self.get_object()
        raw = request.query_params.get("date")
        if raw:
            day = parse_date(raw)
        else:
            day = timezone.now().astimezone(ZoneInfo(court.club.timezone)).date()

        slots = [
            {
                "start": s["start"].isoformat(),
                "end": s["end"].isoformat(),
                "available": s["available"],
                "price": s["price"],
            }
            for s in get_availability(court, day)
        ]
        payload = {
            "court": court.pk,
            "date": day.isoformat(),
            "timezone": court.club.timezone,
            "slots": slots,
        }
        return Response(AvailabilitySerializer(payload).data)


class BookingViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.CreateModelMixin,
    viewsets.GenericViewSet,
):
    def get_serializer_class(self):
        return BookingCreateSerializer if self.action == "create" else BookingSerializer

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Booking.objects.none()

        qs = Booking.objects.filter(court__club__in=clubs_of(self.request.user)).select_related(
            "court"
        )
        if self.action == "list":
            params = self.request.query_params
            if params.get("date"):
                qs = qs.filter(start_at__date=parse_date(params["date"]))
            if params.get("court"):
                if not params["court"].isdigit():
                    raise ValidationError({"court": "Must be a court id."})
                qs = qs.filter(court_id=int(params["court"]))
            if params.get("status"):
                qs = qs.filter(status=params["status"])
        return qs.order_by("start_at")

    @extend_schema(
        parameters=[
            OpenApiParameter("date", str, description="YYYY-MM-DD (server timezone)"),
            OpenApiParameter("court", int),
            OpenApiParameter("status", str, enum=["confirmed", "cancelled"]),
        ]
    )
    def list(self, request, *args, **kwargs):
        return super().list(request, *args, **kwargs)

    @extend_schema(
        request=BookingCreateSerializer,
        responses={201: BookingSerializer},
        description="Returns 409 when the slot is already booked and 400 for any other booking rule.",
    )
    def create(self, request, *args, **kwargs):
        serializer = BookingCreateSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        try:
            booking = create_booking(
                court=data["court"],
                start_at=data["start_at"],
                end_at=data["end_at"],
                customer_name=data["customer_name"],
                customer_phone=data["customer_phone"],
                created_by=request.user,
            )
        except SlotUnavailable as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        except BookingError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(BookingSerializer(booking).data, status=status.HTTP_201_CREATED)

    @extend_schema(request=None, responses=BookingSerializer)
    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        booking = self.get_object()
        cancel_booking(booking)
        return Response(BookingSerializer(booking).data)