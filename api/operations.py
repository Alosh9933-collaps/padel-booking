"""Day-to-day club operations: buffet menu, customers, staff and the daily cash report."""

from decimal import Decimal

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db.models import Count, F, Max, OuterRef, Q, Subquery, Sum, Value
from django.db.models.functions import Coalesce
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from bookings.billing import MONEY, ZERO, totals, with_totals
from bookings.models import Booking, Payment, Refund
from buffet.models import BookingItem, Product, Sale, SaleItem
from buffet.sales import create_sale, void_sale
from cashdesk.models import Activity, Shift
from cashdesk.services import close_shift, current_shift, open_shift, record
from clubs.access import can_manage, clubs_of, managed_clubs_of
from clubs.models import Customer, CustomerCategory, Membership

from .serializers import (
    ActivitySerializer,
    CustomerCategorySerializer,
    CustomerSerializer,
    DailyReportSerializer,
    ProductSerializer,
    SaleCreateSerializer,
    SaleSerializer,
    ShiftCloseSerializer,
    ShiftOpenSerializer,
    ShiftSerializer,
    VoidSerializer,
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
        qs = Customer.objects.filter(club__in=clubs_of(self.request.user)).select_related("category")
        if self.action == "list":
            club = _club_param(self.request)
            if club:
                qs = qs.filter(club_id=club)
            category = self.request.query_params.get("category", "")
            if category == "none":
                qs = qs.filter(category__isnull=True)
            elif category.isdigit():
                qs = qs.filter(category_id=int(category))
            search = self.request.query_params.get("search", "").strip()
            if search:
                digits = "".join(ch for ch in search if ch.isdigit())
                match = Q(name__icontains=search)
                if len(digits) >= 3:
                    match |= Q(phone__contains=digits)
                qs = qs.filter(match)

        # A visit is a confirmed booking that has started; "spent" is money actually received.
        visited = Q(bookings__status=Booking.Status.CONFIRMED, bookings__start_at__lte=timezone.now())
        paid = (
            Payment.objects.filter(booking__customer=OuterRef("pk"))
            .values("booking__customer")
            .annotate(s=Sum("amount"))
            .values("s")
        )
        refunded = (
            Refund.objects.filter(booking__customer=OuterRef("pk"))
            .values("booking__customer")
            .annotate(s=Sum("amount"))
            .values("s")
        )
        sales = (
            Sale.objects.filter(customer=OuterRef("pk"), voided_at__isnull=True)
            .values("customer")
            .annotate(s=Sum("total"))
            .values("s")
        )
        zero = Value(ZERO, output_field=MONEY)
        return qs.annotate(
            visits=Count("bookings", filter=visited, distinct=True),
            no_shows=Count("bookings", filter=Q(bookings__status=Booking.Status.NO_SHOW), distinct=True),
            last_visit=Max("bookings__start_at", filter=visited),
            spent=Coalesce(Subquery(paid, output_field=MONEY), zero)
            - Coalesce(Subquery(refunded, output_field=MONEY), zero)
            + Coalesce(Subquery(sales, output_field=MONEY), zero),
        ).order_by("name")

    @extend_schema(
        parameters=[
            OpenApiParameter("club", int),
            OpenApiParameter("search", str, description="Part of the name, or 3+ digits of the phone"),
            OpenApiParameter("category", str, description="A category id, or 'none'"),
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

        window = {"created_at__gte": start, "created_at__lt": end}
        payments = Payment.objects.filter(booking__court__club=club, **window)
        refunds = Refund.objects.filter(booking__court__club=club, **window)
        sales = Sale.objects.filter(club=club, voided_at__isnull=True, **window)

        def by(qs, field):
            return {r["method"]: (r["s"], r["n"]) for r in qs.values("method").annotate(s=Sum(field), n=Count("id"))}

        paid_by, refunded_by, sold_by = by(payments, "amount"), by(refunds, "amount"), by(sales, "total")
        by_method = []
        for method in Payment.Method.values:
            paid, n_paid = paid_by.get(method, (ZERO, 0))
            sold, n_sold = sold_by.get(method, (ZERO, 0))
            refunded, n_refunded = refunded_by.get(method, (ZERO, 0))
            by_method.append({
                "method": method,
                "bookings": f"{paid:.2f}",
                "sales": f"{sold:.2f}",
                "refunds": f"{refunded:.2f}",
                "total": f"{paid + sold - refunded:.2f}",
                "count": n_paid + n_sold,
            })
        bookings = Booking.objects.filter(
            court__club=club, start_at__gte=start, start_at__lt=end
        ).exclude(status=Booking.Status.CANCELLED)
        lines = {}
        for source in (
            BookingItem.objects.filter(booking__in=bookings),
            SaleItem.objects.filter(sale__in=sales),
        ):
            for r in source.values("name").annotate(qty=Sum("quantity"), total=Sum(F("unit_price") * F("quantity"))):
                q, t = lines.get(r["name"], (0, ZERO))
                lines[r["name"]] = (q + r["qty"], t + r["total"])
        buffet = sorted(
            ({"name": name, "qty": q, "total": t} for name, (q, t) in lines.items()),
            key=lambda r: (-r["total"], r["name"]),
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
            "received": sum((Decimal(r["total"]) for r in by_method), ZERO),
            "refunds_total": refunds.aggregate(s=Sum("amount"))["s"] or ZERO,
            "sales_total": sales.aggregate(s=Sum("total"))["s"] or ZERO,
            "by_method": by_method,
            "buffet": [
                {"name": r["name"], "quantity": r["qty"], "total": f"{r['total']:.2f}"} for r in buffet
            ],
            "buffet_total": sum((Decimal(r["total"]) for r in buffet), ZERO),
            "discount_total": bookings.filter(status=Booking.Status.CONFIRMED).aggregate(s=Sum("discount"))["s"] or ZERO,
            "bookings": bookings.count(),
            "unpaid": unpaid,
            "unpaid_total": sum((totals(b)["balance"] for b in unpaid), ZERO),
        }
        return Response(DailyReportSerializer(report).data)


class CustomerCategoryViewSet(ManagedByClubMixin, viewsets.ModelViewSet):
    """Labels for customers (Regular, VIP, Coach...). Staff read them; owners and managers edit."""

    serializer_class = CustomerCategorySerializer

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return CustomerCategory.objects.none()
        qs = CustomerCategory.objects.filter(club__in=clubs_of(self.request.user)).annotate(
            customers_count=Count("customers")
        )
        club = _club_param(self.request)
        if club and self.action == "list":
            qs = qs.filter(club_id=club)
        return qs.order_by("name")

    @extend_schema(parameters=[OpenApiParameter("club", int)])
    def list(self, request, *args, **kwargs):
        return super().list(request, *args, **kwargs)


class SaleViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    """Counter sales from the buffet, without a booking. Any staff member can sell and void."""

    serializer_class = SaleSerializer

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Sale.objects.none()
        qs = (
            Sale.objects.filter(club__in=clubs_of(self.request.user))
            .select_related("created_by", "voided_by")
            .prefetch_related("items")
        )
        if self.action == "list":
            club = _club_param(self.request)
            if club:
                qs = qs.filter(club_id=club)
            raw = self.request.query_params.get("date")
            if raw:
                day = parse_date(raw)
                if club:
                    start, end = _local_range(get_object_or_404(clubs_of(self.request.user), pk=club), day, day)
                    qs = qs.filter(created_at__gte=start, created_at__lt=end)
                else:
                    qs = qs.filter(created_at__date=day)
        return qs.order_by("-created_at")

    @extend_schema(
        parameters=[
            OpenApiParameter("club", int),
            OpenApiParameter("date", str, description="YYYY-MM-DD in the club's timezone"),
        ]
    )
    def list(self, request, *args, **kwargs):
        return super().list(request, *args, **kwargs)

    @extend_schema(request=SaleCreateSerializer, responses={201: SaleSerializer})
    def create(self, request):
        serializer = SaleCreateSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        sale = create_sale(
            club=data["club"],
            lines=[(line["product"], line["quantity"]) for line in data["items"]],
            method=data["method"],
            customer_name=data["customer_name"],
            customer_phone=data["customer_phone"],
            created_by=request.user,
        )
        record(
            sale.club,
            request.user,
            "sale.created",
            sale=sale,
            amount=sale.total,
            method=sale.method,
            customer=sale.customer_name,
            items=[f"{i.quantity} x {i.name}" for i in sale.items.all()],
        )
        return Response(SaleSerializer(sale).data, status=status.HTTP_201_CREATED)

    @extend_schema(request=VoidSerializer, responses=SaleSerializer)
    @action(detail=True, methods=["post"])
    def void(self, request, pk=None):
        """The money was given back: the sale stays on record but counts for nothing."""
        sale = self.get_object()
        serializer = VoidSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        void_sale(sale, user=request.user, reason=serializer.validated_data["reason"])
        record(sale.club, request.user, "sale.voided", sale=sale, amount=sale.total, reason=sale.void_reason)
        return Response(SaleSerializer(sale).data)


class ShiftViewSet(mixins.ListModelMixin, viewsets.GenericViewSet):
    """Cash drawer shifts. Any staff member opens and closes; owners and managers see the history."""

    serializer_class = ShiftSerializer

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Shift.objects.none()
        user = self.request.user
        qs = Shift.objects.filter(club__in=clubs_of(user)).select_related("club", "opened_by", "closed_by")
        if self.action == "list":
            # The history of past shifts is for owners and managers.
            qs = qs.filter(club__in=managed_clubs_of(user))
            club = _club_param(self.request)
            if club:
                qs = qs.filter(club_id=club)
        return qs.order_by("-opened_at")

    @extend_schema(parameters=[OpenApiParameter("club", int)])
    def list(self, request, *args, **kwargs):
        queryset = self.get_queryset()[:60]
        return Response(ShiftSerializer(queryset, many=True).data)

    @extend_schema(
        parameters=[OpenApiParameter("club", int, required=True)],
        responses=ShiftSerializer,
        description="The club's open shift with live cash totals, or 204 when none is open.",
    )
    @action(detail=False, methods=["get"])
    def current(self, request):
        club = get_object_or_404(clubs_of(request.user), pk=_club_param(request, required=True))
        shift = current_shift(club)
        if shift is None:
            return Response(status=status.HTTP_204_NO_CONTENT)
        return Response(ShiftSerializer(shift).data)

    @extend_schema(request=ShiftOpenSerializer, responses={201: ShiftSerializer})
    @action(detail=False, methods=["post"], url_path="open")
    def open(self, request):
        serializer = ShiftOpenSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        club = serializer.validated_data["club"]
        shift = open_shift(club, request.user, serializer.validated_data["opening_cash"])
        record(club, request.user, "shift.opened", amount=shift.opening_cash, shift=shift.pk)
        return Response(ShiftSerializer(shift).data, status=status.HTTP_201_CREATED)

    @extend_schema(request=ShiftCloseSerializer, responses=ShiftSerializer)
    @action(detail=True, methods=["post"])
    def close(self, request, pk=None):
        shift = get_object_or_404(Shift.objects.filter(club__in=clubs_of(request.user)), pk=pk)
        serializer = ShiftCloseSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        close_shift(shift, request.user, serializer.validated_data["counted_cash"], serializer.validated_data["note"])
        record(
            shift.club,
            request.user,
            "shift.closed",
            amount=shift.counted_cash,
            shift=shift.pk,
            expected=shift.expected_cash,
            difference=shift.counted_cash - shift.expected_cash,
        )
        return Response(ShiftSerializer(shift).data)


class ActivityViewSet(mixins.ListModelMixin, viewsets.GenericViewSet):
    """The club's activity log, newest first. Owners and managers only."""

    serializer_class = ActivitySerializer

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Activity.objects.none()
        qs = Activity.objects.filter(club__in=managed_clubs_of(self.request.user)).select_related("user")
        params = self.request.query_params
        club = _club_param(self.request)
        if club:
            qs = qs.filter(club_id=club)
        if params.get("booking", "").isdigit():
            qs = qs.filter(booking_id=int(params["booking"]))
        if params.get("user", "").isdigit():
            qs = qs.filter(user_id=int(params["user"]))
        if params.get("action"):
            qs = qs.filter(action__startswith=params["action"])
        if params.get("date") and club:
            day = parse_date(params["date"])
            start, end = _local_range(get_object_or_404(clubs_of(self.request.user), pk=club), day, day)
            qs = qs.filter(created_at__gte=start, created_at__lt=end)
        return qs.order_by("-created_at")

    @extend_schema(
        parameters=[
            OpenApiParameter("club", int),
            OpenApiParameter("date", str, description="YYYY-MM-DD in the club's timezone (needs club)"),
            OpenApiParameter("booking", int),
            OpenApiParameter("user", int),
            OpenApiParameter("action", str, description="Prefix, e.g. 'discount' or 'payment.added'"),
        ]
    )
    def list(self, request, *args, **kwargs):
        return Response(ActivitySerializer(self.get_queryset()[:300], many=True).data)
