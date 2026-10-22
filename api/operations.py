"""Day-to-day club operations: buffet menu, customers, staff and the daily cash report."""

from decimal import Decimal

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db.models import Count, F, Max, OuterRef, Q, Subquery, Sum, Value
from django.db.models.functions import Coalesce
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import mixins, status, viewsets
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from bookings.billing import MONEY, ZERO, totals, with_totals
from bookings.models import Booking, Payment
from buffet.models import BookingItem, Product
from clubs.access import can_manage, clubs_of, managed_clubs_of
from clubs.models import Customer, Membership

from .serializers import (
    CustomerSerializer,
    DailyReportSerializer,
    ProductSerializer,
    StaffCreateSerializer,
    StaffSerializer,
)
from .views import MANAGERS_ONLY, ManagedByClubMixin, _local_range, parse_date


def _club_param(request, required=False):
    raw = request.query_params.get("club")
    if not raw:
        if required:
            raise ValidationError({"club": "This parameter is required."})
        return None
    if not raw.isdigit():
        raise ValidationError({"club": "Must be a club id."})
    return int(raw)


class ProductViewSet(ManagedByClubMixin, viewsets.ModelViewSet):
    """The buffet menu. Staff read it; owners and managers edit it.

    Deleting a product is safe: bills keep the name and price they were sold at.
    """

    serializer_class = ProductSerializer

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Product.objects.none()
        qs = Product.objects.filter(club__in=clubs_of(self.request.user))
        club = _club_param(self.request)
        if club and self.action == "list":
            qs = qs.filter(club_id=club)
        return qs.order_by("category", "name")

    @extend_schema(parameters=[OpenApiParameter("club", int)])
    def list(self, request, *args, **kwargs):
        return super().list(request, *args, **kwargs)


class CustomerViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.CreateModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet,
):
    """The club's players, with visit and spending history. Any staff member can edit."""

    serializer_class = CustomerSerializer

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Customer.objects.none()
        qs = Customer.objects.filter(club__in=clubs_of(self.request.user))
        if self.action == "list":
            club = _club_param(self.request)
            if club:
                qs = qs.filter(club_id=club)
            search = self.request.query_params.get("search", "").strip()
            if search:
                digits = "".join(ch for ch in search if ch.isdigit())
                match = Q(name__icontains=search)
                if len(digits) >= 3:
                    match |= Q(phone__contains=digits)
                qs = qs.filter(match)

        done = Booking.objects.filter(customer=OuterRef("pk"), status=Booking.Status.CONFIRMED, is_open=False)
        spent = (
            with_totals(done)
            .values("customer")
            .annotate(s=Sum(F("price") + F("items_total")))
            .values("s")
        )
        return qs.annotate(
            visits=Count("bookings", filter=Q(bookings__status=Booking.Status.CONFIRMED), distinct=True),
            no_shows=Count("bookings", filter=Q(bookings__status=Booking.Status.NO_SHOW), distinct=True),
            last_visit=Max("bookings__start_at", filter=Q(bookings__status=Booking.Status.CONFIRMED)),
            spent=Coalesce(Subquery(spent, output_field=MONEY), Value(ZERO, output_field=MONEY)),
        ).order_by("name")

    @extend_schema(
        parameters=[
            OpenApiParameter("club", int),
            OpenApiParameter("search", str, description="Part of the name, or 3+ digits of the phone"),
        ]
    )
    def list(self, request, *args, **kwargs):
        return super().list(request, *args, **kwargs)


class StaffViewSet(
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    """Who works at the club. Owners manage everyone; managers manage receptionists only."""

    serializer_class = StaffSerializer
    http_method_names = ["get", "post", "patch", "delete"]

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Membership.objects.none()
        qs = Membership.objects.filter(club__in=managed_clubs_of(self.request.user)).select_related("user")
        club = _club_param(self.request)
        if club and self.action == "list":
            qs = qs.filter(club_id=club)
        return qs.order_by("club_id", "role", "user__username")

    def _check_can_assign(self, club, role):
        mine = Membership.objects.filter(club=club, user=self.request.user).values_list("role", flat=True).first()
        if mine == Membership.Role.OWNER:
            return
        if mine == Membership.Role.MANAGER and role == Membership.Role.RECEPTIONIST:
            return
        raise PermissionDenied("Managers can only manage receptionists. Ask the owner.")

    @extend_schema(parameters=[OpenApiParameter("club", int)])
    def list(self, request, *args, **kwargs):
        return super().list(request, *args, **kwargs)

    @extend_schema(request=StaffCreateSerializer, responses={201: StaffSerializer})
    def create(self, request, *args, **kwargs):
        serializer = StaffCreateSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        club = data["club"]
        if not can_manage(request.user, club):
            raise PermissionDenied(MANAGERS_ONLY)
        self._check_can_assign(club, data["role"])

        User = get_user_model()
        user = User.objects.filter(username=data["username"]).first()
        if user is None:
            password = data.get("password") or ""
            if not password:
                raise ValidationError({"password": "Set a password for the new account."})
            try:
                validate_password(password)
            except DjangoValidationError as exc:
                raise ValidationError({"password": list(exc.messages)})
            user = User.objects.create_user(
                data["username"], password=password, first_name=data.get("first_name", "")
            )
        if Membership.objects.filter(club=club, user=user).exists():
            raise ValidationError({"username": "This person already works at this club."})
        membership = Membership.objects.create(club=club, user=user, role=data["role"])
        return Response(StaffSerializer(membership).data, status=status.HTTP_201_CREATED)

    def perform_update(self, serializer):
        membership = serializer.instance
        new_role = serializer.validated_data.get("role", membership.role)
        if membership.user_id == self.request.user.pk:
            raise PermissionDenied("You cannot change your own role.")
        self._check_can_assign(membership.club, membership.role)
        self._check_can_assign(membership.club, new_role)
        serializer.save()

    def perform_destroy(self, membership):
        if membership.user_id == self.request.user.pk:
            raise PermissionDenied("You cannot remove yourself.")
        self._check_can_assign(membership.club, membership.role)
        membership.delete()


class DailyReportView(APIView):
    """End-of-day cash-up for any staff member: money received, buffet sales, unpaid bills."""

    @extend_schema(
        parameters=[
            OpenApiParameter("club", int, required=True),
            OpenApiParameter("date", str, required=True, description="YYYY-MM-DD in the club's timezone"),
        ],
        responses=DailyReportSerializer,
    )
    def get(self, request):
        club = get_object_or_404(clubs_of(request.user), pk=_club_param(request, required=True))
        raw = request.query_params.get("date")
        if not raw:
            raise ValidationError({"date": "This parameter is required."})
        day = parse_date(raw)
        start, end = _local_range(club, day, day)

        payments = Payment.objects.filter(
            booking__court__club=club, created_at__gte=start, created_at__lt=end
        )
        by_method = list(
            payments.values("method").annotate(total=Sum("amount"), count=Count("id")).order_by("method")
        )
        bookings = Booking.objects.filter(
            court__club=club, start_at__gte=start, start_at__lt=end
        ).exclude(status=Booking.Status.CANCELLED)
        buffet = list(
            BookingItem.objects.filter(booking__in=bookings)
            .values("name")
            .annotate(qty=Sum("quantity"), total=Sum(F("unit_price") * F("quantity")))
            .order_by("-total", "name")
        )
        unpaid = [
            b
            for b in with_totals(bookings.filter(status=Booking.Status.CONFIRMED, is_open=False))
            .select_related("court")
            .order_by("start_at")
            if totals(b)["balance"] > 0
        ]

        report = {
            "club": club.pk,
            "date": day,
            "currency": club.currency,
            "received": payments.aggregate(s=Sum("amount"))["s"] or ZERO,
            "by_method": [
                {"method": r["method"], "total": f"{r['total']:.2f}", "count": r["count"]} for r in by_method
            ],
            "buffet": [
                {"name": r["name"], "quantity": r["qty"], "total": f"{r['total']:.2f}"} for r in buffet
            ],
            "buffet_total": sum((Decimal(r["total"]) for r in buffet), ZERO),
            "bookings": bookings.count(),
            "unpaid": unpaid,
            "unpaid_total": sum((totals(b)["balance"] for b in unpaid), ZERO),
        }
        return Response(DailyReportSerializer(report).data)
