from datetime import date as date_type
from datetime import datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.db.models import Count, F, OuterRef, Subquery, Sum
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
from bookings.billing import (
    add_item,
    add_payment,
    apply_manual_discount,
    apply_offer,
    remove_discount,
    set_item_quantity,
    with_totals,
)
from bookings.models import Booking
from bookings.services import (
    calculate_price,
    cancel_booking,
    cancel_following,
    change_booking,
    create_booking,
    create_weekly,
    mark_no_show,
    plan_weekly,
    start_open_session,
    stop_open_session,
    validate_window,
)
from buffet.models import BookingItem
from clubs.access import can_manage, clubs_of, managed_clubs_of
from clubs.models import Club, Court, DiscountSettings, Membership, PriceRule

from .serializers import (
    AvailabilitySerializer,
    BookingBillSerializer,
    BookingChangeSerializer,
    BookingCreateSerializer,
    BookingSerializer,
    ClubSerializer,
    CourtSerializer,
    DiscountSerializer,
    DiscountSettingsSerializer,
    ItemAddSerializer,
    ItemQuantitySerializer,
    OpenSessionStartSerializer,
    PaymentAddSerializer,
    PriceRuleSerializer,
    QuoteSerializer,
    RevenueReportSerializer,
    WeeklyBookingSerializer,
    WeeklyResultSerializer,
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
        validate_window(court, start, end)
        price = calculate_price(court, start, end)
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

    @extend_schema(request=DiscountSettingsSerializer, responses=DiscountSettingsSerializer)
    @action(detail=True, methods=["get", "patch"])
    def discounts(self, request, pk=None):
        """The club's loyalty rules. Everyone reads them; owners and managers change them."""
        club = self.get_object()
        rules, _ = DiscountSettings.objects.get_or_create(club=club)
        if request.method == "GET":
            return Response(DiscountSettingsSerializer(rules).data)
        serializer = DiscountSettingsSerializer(rules, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)


class BookingViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.CreateModelMixin,
    viewsets.GenericViewSet,
):
    """Every member of a club can book, change, cancel, bill and take payments.

    Expected booking problems come back as {"detail", "code"}: 409 for an
    overlap, 400 for anything else (see api.exceptions).
    """

    def get_serializer_class(self):
        if self.action == "create":
            return BookingCreateSerializer
        if self.action == "retrieve":
            return BookingBillSerializer
        return BookingSerializer

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Booking.objects.none()

        qs = with_totals(
            Booking.objects.filter(court__club__in=clubs_of(self.request.user)).select_related(
                "court", "court__club"
            )
        )
        if self.action == "retrieve":
            qs = qs.prefetch_related("items", "payments__created_by")
        if self.action == "list":
            params = self.request.query_params
            if params.get("date"):
                qs = qs.filter(start_at__date=parse_date(params["date"]))
            if params.get("court"):
                if not params["court"].isdigit():
                    raise ValidationError({"court": "Must be a court id."})
                qs = qs.filter(court_id=int(params["court"]))
            if params.get("customer"):
                if not params["customer"].isdigit():
                    raise ValidationError({"customer": "Must be a customer id."})
                qs = qs.filter(customer_id=int(params["customer"]))
            if params.get("status"):
                qs = qs.filter(status=params["status"])
        return qs.order_by("start_at")

    def bill(self, booking, status_code=status.HTTP_200_OK):
        """The booking re-read with fresh totals, items and payments."""
        fresh = (
            with_totals(Booking.objects.filter(pk=booking.pk))
            .select_related("court")
            .prefetch_related("items", "payments__created_by")
            .get()
        )
        return Response(BookingBillSerializer(fresh).data, status=status_code)

    @extend_schema(
        parameters=[
            OpenApiParameter("date", str, description="YYYY-MM-DD (server timezone)"),
            OpenApiParameter("court", int),
            OpenApiParameter("customer", int),
            OpenApiParameter("status", str, enum=["confirmed", "cancelled", "no_show"]),
        ]
    )
    def list(self, request, *args, **kwargs):
        return super().list(request, *args, **kwargs)

    @extend_schema(
        request=BookingCreateSerializer,
        responses={201: BookingBillSerializer},
        description="Returns 409 when the slot is already booked and 400 for any other booking rule.",
    )
    def create(self, request, *args, **kwargs):
        serializer = BookingCreateSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        booking = create_booking(
            court=data["court"],
            start_at=data["start_at"],
            end_at=data["end_at"],
            customer_name=data["customer_name"],
            customer_phone=data["customer_phone"],
            created_by=request.user,
        )
        return self.bill(booking, status.HTTP_201_CREATED)

    @extend_schema(
        request=BookingChangeSerializer,
        responses=BookingBillSerializer,
        description=(
            "Extend, shorten or move a booking, or fix the customer details. A new time is "
            "re-priced. Returns 409 when the new time overlaps another booking."
        ),
    )
    def partial_update(self, request, pk=None):
        booking = self.get_object()
        serializer = BookingChangeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        change_booking(booking, **serializer.validated_data)
        return self.bill(booking)

    @extend_schema(request=None, responses=BookingBillSerializer)
    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        return self.bill(cancel_booking(self.get_object()))

    @extend_schema(
        request=None,
        responses=BookingSerializer(many=True),
        description="Cancel this booking and every later booking of its weekly series.",
    )
    @action(detail=True, methods=["post"], url_path="cancel-following")
    def cancel_following(self, request, pk=None):
        cancelled = cancel_following(self.get_object())
        return Response(BookingSerializer(cancelled, many=True).data)

    @extend_schema(request=None, responses=BookingBillSerializer)
    @action(detail=True, methods=["post"], url_path="no-show")
    def no_show(self, request, pk=None):
        """The customer never came: the booking stays on record and the court is freed."""
        return self.bill(mark_no_show(self.get_object()))

    @extend_schema(
        request=OpenSessionStartSerializer,
        responses={201: BookingBillSerializer},
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
        booking = start_open_session(
            court=data["court"],
            customer_name=data["customer_name"],
            customer_phone=data["customer_phone"],
            created_by=request.user,
        )
        return self.bill(booking, status.HTTP_201_CREATED)

    @extend_schema(request=None, responses=BookingBillSerializer)
    @action(detail=True, methods=["post"])
    def stop(self, request, pk=None):
        """End open play now and charge the exact minutes played."""
        return self.bill(stop_open_session(self.get_object()))

    @extend_schema(
        request=WeeklyBookingSerializer,
        responses={200: WeeklyResultSerializer, 201: WeeklyResultSerializer},
        description=(
            "Book the same time every week. With dry_run=true nothing is booked and "
            "'skipped' lists every week with ok=true/false. Weeks that are taken are "
            "skipped, the rest are booked."
        ),
    )
    @action(detail=False, methods=["post"])
    def weekly(self, request):
        serializer = WeeklyBookingSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        if data["dry_run"]:
            plan = plan_weekly(
                court=data["court"], start_at=data["start_at"], end_at=data["end_at"], weeks=data["weeks"]
            )
            return Response(WeeklyResultSerializer({"created": [], "skipped": plan}).data)
        created, skipped = create_weekly(
            court=data["court"],
            start_at=data["start_at"],
            end_at=data["end_at"],
            weeks=data["weeks"],
            customer_name=data["customer_name"],
            customer_phone=data["customer_phone"],
            created_by=request.user,
        )
        for entry in skipped:
            entry.update(price=None, ok=False)
        return Response(
            WeeklyResultSerializer({"created": created, "skipped": skipped}).data,
            status=status.HTTP_201_CREATED,
        )

    @extend_schema(request=ItemAddSerializer, responses={201: BookingBillSerializer})
    @action(detail=True, methods=["post"])
    def items(self, request, pk=None):
        """Add a buffet product to the bill (the same product again raises the quantity)."""
        booking = self.get_object()
        serializer = ItemAddSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        add_item(
            booking,
            serializer.validated_data["product"],
            serializer.validated_data["quantity"],
            created_by=request.user,
        )
        return self.bill(booking, status.HTTP_201_CREATED)

    @extend_schema(request=ItemQuantitySerializer, responses=BookingBillSerializer)
    @action(detail=True, methods=["patch"], url_path=r"items/(?P<item_id>\d+)")
    def item(self, request, pk=None, item_id=None):
        """Change an item's quantity; 0 removes it from the bill."""
        booking = self.get_object()
        item = get_object_or_404(booking.items, pk=item_id)
        serializer = ItemQuantitySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        set_item_quantity(item, serializer.validated_data["quantity"])
        return self.bill(booking)

    @extend_schema(
        methods=["POST"],
        request=DiscountSerializer,
        responses=BookingBillSerializer,
        description=(
            "Apply the bill's one discount, replacing any earlier one. kind=first_visit, "
            "nth_visit or category applies a loyalty offer the booking qualifies for (court "
            "time only); kind=manual takes a percent (of 'court' or 'total') or an amount."
        ),
    )
    @extend_schema(methods=["DELETE"], request=None, responses=BookingBillSerializer)
    @action(detail=True, methods=["post", "delete"])
    def discount(self, request, pk=None):
        booking = self.get_object()
        if request.method == "DELETE":
            remove_discount(booking)
            return self.bill(booking)
        serializer = DiscountSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        if data["kind"] == "manual":
            apply_manual_discount(
                booking,
                percent=data.get("percent"),
                amount=data.get("amount"),
                scope=data["scope"],
                note=data["note"],
            )
        else:
            apply_offer(booking, data["kind"])
        return self.bill(booking)

    @extend_schema(request=PaymentAddSerializer, responses={201: BookingBillSerializer})
    @action(detail=True, methods=["post"])
    def payments(self, request, pk=None):
        """Record money received. Several payments can split one bill."""
        booking = self.get_object()
        serializer = PaymentAddSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        add_payment(booking, created_by=request.user, **serializer.validated_data)
        return self.bill(booking, status.HTTP_201_CREATED)

    @extend_schema(request=None, responses=BookingBillSerializer)
    @action(detail=True, methods=["delete"], url_path=r"payments/(?P<payment_id>\d+)")
    def payment(self, request, pk=None, payment_id=None):
        """Remove a payment entered by mistake. Owners and managers only."""
        booking = self.get_object()
        if not can_manage(request.user, booking.court.club):
            raise PermissionDenied(MANAGERS_ONLY)
        get_object_or_404(booking.payments, pk=payment_id).delete()
        return self.bill(booking)


def _report_range(request, managers_only=True):
    params = request.query_params
    missing = {k: "This parameter is required." for k in ("club", "from", "to") if not params.get(k)}
    if missing:
        raise ValidationError(missing)
    if not params["club"].isdigit():
        raise ValidationError({"club": "Must be a club id."})

    club = get_object_or_404(clubs_of(request.user), pk=int(params["club"]))
    if managers_only and not can_manage(request.user, club):
        raise PermissionDenied(MANAGERS_ONLY)

    date_from = parse_date(params["from"], "from")
    date_to = parse_date(params["to"], "to")
    if date_to < date_from:
        raise ValidationError({"to": "Must not be before 'from'."})
    if (date_to - date_from).days >= MAX_REPORT_DAYS:
        raise ValidationError({"to": f"The range cannot exceed {MAX_REPORT_DAYS} days."})
    return club, date_from, date_to


def _local_range(club, date_from, date_to):
    tz = ZoneInfo(club.timezone)
    return (
        datetime.combine(date_from, time(0), tzinfo=tz),
        datetime.combine(date_to + timedelta(days=1), time(0), tzinfo=tz),
    )


class RevenueReportView(APIView):
    """Confirmed, finished bookings: court time and buffet, by court and by day (club's timezone)."""

    @extend_schema(
        parameters=[
            OpenApiParameter("club", int, required=True),
            OpenApiParameter("from", str, required=True, description="YYYY-MM-DD, inclusive"),
            OpenApiParameter("to", str, required=True, description="YYYY-MM-DD, inclusive"),
        ],
        responses=RevenueReportSerializer,
    )
    def get(self, request):
        club, date_from, date_to = _report_range(request)
        start, end = _local_range(club, date_from, date_to)
        tz = ZoneInfo(club.timezone)
        bookings = Booking.objects.filter(
            court__club=club,
            status=Booking.Status.CONFIRMED,
            is_open=False,  # running open play has no price yet
            start_at__gte=start,
            start_at__lt=end,
        )
        items = BookingItem.objects.filter(booking__in=bookings)
        line = F("unit_price") * F("quantity")
        zero = Decimal("0.00")

        court_totals = bookings.aggregate(total=Sum("price"), count=Count("id"), discounts=Sum("discount"))
        buffet_total = items.aggregate(total=Sum(line))["total"] or zero
        by_court = (
            bookings.values("court_id", "court__name")
            .annotate(total=Sum("price"), count=Count("id"))
            .order_by("court__name")
        )
        by_day = (
            bookings.annotate(day=TruncDate("start_at", tzinfo=tz))
            .values("day")
            .annotate(total=Sum("price"), count=Count("id"), discounts=Sum("discount"))
            .order_by("day")
        )
        buffet_by_day = dict(
            items.annotate(day=TruncDate("booking__start_at", tzinfo=tz))
            .values("day")
            .annotate(total=Sum(line))
            .values_list("day", "total")
        )

        report = {
            "club": club.pk,
            "currency": club.currency,
            "timezone": club.timezone,
            "date_from": date_from,
            "date_to": date_to,
            "total": court_totals["total"] or zero,
            "buffet_total": buffet_total,
            "discount_total": court_totals["discounts"] or zero,
            "grand_total": (court_totals["total"] or zero) + buffet_total - (court_totals["discounts"] or zero),
            "bookings": court_totals["count"],
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
                {
                    "date": row["day"],
                    "total": row["total"],
                    "buffet": buffet_by_day.get(row["day"], zero),
                    "discounts": row["discounts"] or zero,
                    "bookings": row["count"],
                }
                for row in by_day
            ],
        }
        return Response(RevenueReportSerializer(report).data)
