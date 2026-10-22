from datetime import date as date_type
from datetime import datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.db.models import Count, OuterRef, Subquery, Sum
from django.db.models.functions import TruncDate
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import SAFE_METHODS, BasePermission, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from bookings.availability import get_availability
from bookings.models import Booking
from bookings.services import (
    BookingError,
    SlotUnavailable,
    calculate_price,
    cancel_booking,
    change_booking,
    create_booking,
    start_open_session,
    stop_open_session,
    validate_window,
)
from clubs.access import can_manage, clubs_of, managed_clubs_of
from clubs.models import Club, Court, Membership, PriceRule

from .serializers import (
    AvailabilitySerializer,
    BookingChangeSerializer,
    BookingCreateSerializer,
    BookingSerializer,
    ClubSerializer,
    CourtSerializer,
    OpenSessionStartSerializer,
    PriceRuleSerializer,
    QuoteSerializer,
    RevenueReportSerializer,
)

MANAGERS_ONLY = "Only the club's owner or manager can do this."
MAX_REPORT_DAYS = 366


def parse_date(raw, field="date"):
    try:
        return date_type.fromisoformat(raw)
    except ValueError:
        raise ValidationError({field: "Use the format YYYY-MM-DD."})


class IsClubManagerOrReadOnly(BasePermission):
    """Every member of a club can read; only owners and managers can write."""

    message = MANAGERS_ONLY

    def has_permission(self, request, view):
        if request.method != "POST":
            return True
        # Creating needs a managed club somewhere; the exact club is checked
        # once the payload is validated (see ManagedByClubMixin.perform_create).
        return managed_clubs_of(request.user).exists()

    def has_object_permission(self, request, view, obj):
        if request.method in SAFE_METHODS:
            return True
        club = obj if isinstance(obj, Club) else obj.club
        return can_manage(request.user, club)


class ManagedByClubMixin:
    permission_classes = [IsAuthenticated, IsClubManagerOrReadOnly]

    def perform_create(self, serializer):
        if not can_manage(self.request.user, serializer.validated_data["club"]):
            raise PermissionDenied(MANAGERS_ONLY)
        serializer.save()


class CourtViewSet(
    ManagedByClubMixin,
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.CreateModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet,
):
    """Courts are never deleted because bookings point at them; set is_active=false instead."""

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

    @extend_schema(
        parameters=[
            OpenApiParameter("start", str, required=True, description="ISO 8601 with offset"),
            OpenApiParameter("end", str, required=True, description="ISO 8601 with offset"),
        ],
        responses=QuoteSerializer,
        description="Price of a booking before making it. Does not check whether the court is free.",
    )
    @action(detail=True, methods=["get"])
    def quote(self, request, pk=None):
        court = self.get_object()
        query = QuoteSerializer(data=request.query_params)
        query.is_valid(raise_exception=True)
        start, end = query.validated_data["start"], query.validated_data["end"]
        try:
            validate_window(court, start, end)
            price = calculate_price(court, start, end)
        except BookingError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(QuoteSerializer({"start": start, "end": end, "price": price}).data)


class PriceRuleViewSet(ManagedByClubMixin, viewsets.ModelViewSet):
    """Deleting a rule is safe: every booking keeps the price it was made with."""

    serializer_class = PriceRuleSerializer

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return PriceRule.objects.none()
        qs = PriceRule.objects.filter(club__in=clubs_of(self.request.user)).select_related(
            "club", "court"
        )
        if self.action == "list":
            club = self.request.query_params.get("club")
            if club:
                if not club.isdigit():
                    raise ValidationError({"club": "Must be a club id."})
                qs = qs.filter(club_id=int(club))
        return qs.order_by("club_id", "court_id", "start_hour", "id")

    @extend_schema(parameters=[OpenApiParameter("club", int)])
    def list(self, request, *args, **kwargs):
        return super().list(request, *args, **kwargs)


class ClubViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet,
):
    """Your clubs, with your role in each. Owners and managers can edit hours and timezone."""

    serializer_class = ClubSerializer
    permission_classes = [IsAuthenticated, IsClubManagerOrReadOnly]

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Club.objects.none()
        user = self.request.user
        role = Membership.objects.filter(club=OuterRef("pk"), user=user).values("role")[:1]
        return clubs_of(user).annotate(role=Subquery(role)).order_by("name")


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

    @extend_schema(
        request=BookingChangeSerializer,
        responses=BookingSerializer,
        description=(
            "Extend, shorten or move a booking, or fix the customer details. A new time is "
            "re-priced. Returns 409 when the new time overlaps another booking."
        ),
    )
    def partial_update(self, request, pk=None):
        booking = self.get_object()
        serializer = BookingChangeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            change_booking(booking, **serializer.validated_data)
        except SlotUnavailable as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        except BookingError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(BookingSerializer(booking).data)

    @extend_schema(request=None, responses=BookingSerializer)
    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        booking = self.get_object()
        cancel_booking(booking)
        return Response(BookingSerializer(booking).data)

    @extend_schema(
        request=OpenSessionStartSerializer,
        responses={201: BookingSerializer},
        description=(
            "Start open play now, with no end time. The court is held until closing time "
            "until the session is stopped. Returns 409 when the court is booked later today."
        ),
    )
    @action(detail=False, methods=["post"], url_path="open")
    def start_open(self, request):
        serializer = OpenSessionStartSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        try:
            booking = start_open_session(
                court=data["court"],
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
    def stop(self, request, pk=None):
        """End open play now and charge the exact minutes played."""
        booking = self.get_object()
        try:
            stop_open_session(booking)
        except BookingError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(BookingSerializer(booking).data)


class RevenueReportView(APIView):
    """Confirmed bookings only, grouped by court and by day in the club's timezone."""

    @extend_schema(
        parameters=[
            OpenApiParameter("club", int, required=True),
            OpenApiParameter("from", str, required=True, description="YYYY-MM-DD, inclusive"),
            OpenApiParameter("to", str, required=True, description="YYYY-MM-DD, inclusive"),
        ],
        responses=RevenueReportSerializer,
    )
    def get(self, request):
        params = request.query_params
        missing = {k: "This parameter is required." for k in ("club", "from", "to") if not params.get(k)}
        if missing:
            raise ValidationError(missing)
        if not params["club"].isdigit():
            raise ValidationError({"club": "Must be a club id."})

        club = get_object_or_404(clubs_of(request.user), pk=int(params["club"]))
        if not can_manage(request.user, club):
            raise PermissionDenied(MANAGERS_ONLY)

        date_from = parse_date(params["from"], "from")
        date_to = parse_date(params["to"], "to")
        if date_to < date_from:
            raise ValidationError({"to": "Must not be before 'from'."})
        if (date_to - date_from).days >= MAX_REPORT_DAYS:
            raise ValidationError({"to": f"The range cannot exceed {MAX_REPORT_DAYS} days."})

        tz = ZoneInfo(club.timezone)
        bookings = Booking.objects.filter(
            court__club=club,
            status=Booking.Status.CONFIRMED,
            is_open=False,  # running open play has no price yet
            start_at__gte=datetime.combine(date_from, time(0), tzinfo=tz),
            start_at__lt=datetime.combine(date_to + timedelta(days=1), time(0), tzinfo=tz),
        )
        zero = Decimal("0.00")

        totals = bookings.aggregate(total=Sum("price"), count=Count("id"))
        by_court = (
            bookings.values("court_id", "court__name")
            .annotate(total=Sum("price"), count=Count("id"))
            .order_by("court__name")
        )
        by_day = (
            bookings.annotate(day=TruncDate("start_at", tzinfo=tz))
            .values("day")
            .annotate(total=Sum("price"), count=Count("id"))
            .order_by("day")
        )

        report = {
            "club": club.pk,
            "currency": club.currency,
            "timezone": club.timezone,
            "date_from": date_from,
            "date_to": date_to,
            "total": totals["total"] or zero,
            "bookings": totals["count"],
            "by_court": [
                {
                    "court": row["court_id"],
                    "court_name": row["court__name"],
                    "total": row["total"],
                    "bookings": row["count"],
                }
                for row in by_court
            ],
            "by_day": [
                {"date": row["day"], "total": row["total"], "bookings": row["count"]}
                for row in by_day
            ],
        }
        return Response(RevenueReportSerializer(report).data)
