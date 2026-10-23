from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from bookings.billing import totals
from bookings.discounts import offers
from bookings.models import Booking, Payment
from buffet.models import BookingItem, Product
from clubs.access import clubs_of
from clubs.models import (
    Club,
    Court,
    Customer,
    CustomerCategory,
    DiscountSettings,
    Membership,
    PriceRule,
    normalize_phone,
)


def _user_from(serializer):
    request = serializer.context.get("request")
    if request is not None and request.user.is_authenticated:
        return request.user
    return None


class CourtSerializer(serializers.ModelSerializer):
    club_name = serializers.CharField(source="club.name", read_only=True)

    class Meta:
        model = Court
        fields = ("id", "club", "club_name", "name", "kind", "is_active")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        user = _user_from(self)
        if user is not None and "club" in self.fields:
            # Other clubs look like "club does not exist".
            self.fields["club"].queryset = clubs_of(user)

    def validate_club(self, club):
        if self.instance is not None and club != self.instance.club:
            raise serializers.ValidationError("A court cannot move to another club.")
        return club


class PriceRuleSerializer(serializers.ModelSerializer):
    class Meta:
        model = PriceRule
        fields = (
            "id",
            "club",
            "court",
            "days_of_week",
            "start_hour",
            "end_hour",
            "price_per_hour",
            "priority",
        )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        user = _user_from(self)
        if user is not None:
            self.fields["club"].queryset = clubs_of(user)
            self.fields["court"].queryset = Court.objects.filter(club__in=clubs_of(user))

    def validate_club(self, club):
        if self.instance is not None and club != self.instance.club:
            raise serializers.ValidationError("A price rule cannot move to another club.")
        return club

    def validate_days_of_week(self, days):
        if not days:
            raise serializers.ValidationError("Pick at least one day.")
        return sorted(set(days))

    def validate_price_per_hour(self, price):
        if price < 0:
            raise serializers.ValidationError("Price cannot be negative.")
        return price

    def validate(self, attrs):
        def current(name):
            if name in attrs:
                return attrs[name]
            return getattr(self.instance, name, None)

        start, end = current("start_hour"), current("end_hour")
        if start is not None and end is not None and start >= end:
            raise serializers.ValidationError({"end_hour": "Must be after start_hour."})

        club, court = current("club"), current("court")
        if court is not None and court.club_id != club.pk:
            raise serializers.ValidationError({"court": "This court belongs to a different club."})
        return attrs


class ClubSerializer(serializers.ModelSerializer):
    role = serializers.CharField(read_only=True, help_text="Your role in this club.")

    class Meta:
        model = Club
        fields = (
            "id",
            "name",
            "timezone",
            "currency",
            "opening_hour",
            "closing_hour",
            "slot_minutes",
            "role",
        )
        # Changing the slot grid would leave existing bookings off-grid.
        read_only_fields = ("id", "name", "currency", "slot_minutes", "role")

    def validate_timezone(self, value):
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise serializers.ValidationError("Unknown timezone name.")
        return value

    def validate(self, attrs):
        opening = attrs.get("opening_hour", self.instance.opening_hour)
        closing = attrs.get("closing_hour", self.instance.closing_hour)
        if closing < 1 or opening >= closing:
            raise serializers.ValidationError(
                {"closing_hour": "Must be after opening_hour (1-24, where 24 is midnight)."}
            )
        return attrs


class SlotSerializer(serializers.Serializer):
    start = serializers.CharField(help_text="ISO 8601 with the club's UTC offset")
    end = serializers.CharField(help_text="ISO 8601 with the club's UTC offset")
    available = serializers.BooleanField()
    price = serializers.DecimalField(max_digits=10, decimal_places=2, allow_null=True)


class AvailabilitySerializer(serializers.Serializer):
    court = serializers.IntegerField()
    date = serializers.CharField()
    timezone = serializers.CharField()
    slots = SlotSerializer(many=True)


MONEY = {"max_digits": 12, "decimal_places": 2}


class BillTotalsMixin(serializers.Serializer):
    """Bill totals of a booking: court time + buffet items, minus payments."""

    court_total = serializers.SerializerMethodField()
    items_total = serializers.SerializerMethodField()
    total = serializers.SerializerMethodField()
    paid_total = serializers.SerializerMethodField()
    balance = serializers.SerializerMethodField()
    payment_status = serializers.SerializerMethodField()

    def _totals(self, booking):
        cache = self.context.setdefault("_totals", {})
        if booking.pk not in cache:
            cache[booking.pk] = totals(booking)
        return cache[booking.pk]

    @extend_schema_field(serializers.DecimalField(**MONEY))
    def get_court_total(self, b):
        return f"{self._totals(b)['court_total']:.2f}"

    @extend_schema_field(serializers.DecimalField(**MONEY))
    def get_items_total(self, b):
        return f"{self._totals(b)['items_total']:.2f}"

    @extend_schema_field(serializers.DecimalField(**MONEY))
    def get_total(self, b):
        return f"{self._totals(b)['total']:.2f}"

    @extend_schema_field(serializers.DecimalField(**MONEY))
    def get_paid_total(self, b):
        return f"{self._totals(b)['paid_total']:.2f}"

    @extend_schema_field(serializers.DecimalField(**MONEY))
    def get_balance(self, b):
        return f"{self._totals(b)['balance']:.2f}"

    @extend_schema_field(serializers.ChoiceField(choices=["unpaid", "partial", "paid", "open"]))
    def get_payment_status(self, b):
        return self._totals(b)["payment_status"]


BOOKING_FIELDS = (
    "id",
    "court",
    "court_name",
    "start_at",
    "end_at",
    "customer",
    "customer_name",
    "customer_phone",
    "price",
    "status",
    "is_open",
    "series",
    "discount_kind",
    "discount_percent",
    "discount_fixed",
    "discount_scope",
    "discount_note",
    "discount",
    "created_at",
    "cancelled_at",
    "court_total",
    "items_total",
    "total",
    "paid_total",
    "balance",
    "payment_status",
)


class BookingSerializer(BillTotalsMixin, serializers.ModelSerializer):
    court_name = serializers.CharField(source="court.name", read_only=True)

    class Meta:
        model = Booking
        fields = BOOKING_FIELDS
        read_only_fields = fields


class BookingItemSerializer(serializers.ModelSerializer):
    total = serializers.DecimalField(read_only=True, **MONEY)

    class Meta:
        model = BookingItem
        fields = ("id", "product", "name", "unit_price", "quantity", "total", "created_at")
        read_only_fields = fields


class PaymentSerializer(serializers.ModelSerializer):
    created_by_name = serializers.CharField(source="created_by.username", read_only=True, default="")

    class Meta:
        model = Payment
        fields = ("id", "amount", "method", "payer_name", "created_at", "created_by_name")
        read_only_fields = ("id", "created_at", "created_by_name")


class OfferSerializer(serializers.Serializer):
    kind = serializers.ChoiceField(choices=["first_visit", "nth_visit", "category"])
    percent = serializers.IntegerField()
    amount = serializers.DecimalField(**MONEY)
    visit = serializers.IntegerField(allow_null=True)
    note = serializers.CharField(allow_blank=True)


class BookingBillSerializer(BookingSerializer):
    """A booking with its full bill: buffet items, payments and the loyalty offers it qualifies for."""

    items = BookingItemSerializer(many=True, read_only=True)
    payments = PaymentSerializer(many=True, read_only=True)
    offers = serializers.SerializerMethodField()

    class Meta(BookingSerializer.Meta):
        fields = BOOKING_FIELDS + ("items", "payments", "offers")
        read_only_fields = fields

    @extend_schema_field(OfferSerializer(many=True))
    def get_offers(self, booking):
        return OfferSerializer(offers(booking), many=True).data


class DiscountSerializer(serializers.Serializer):
    """Apply a loyalty offer (kind + nothing else) or a manual discount (percent or amount)."""

    kind = serializers.ChoiceField(choices=["first_visit", "nth_visit", "category", "manual"])
    percent = serializers.DecimalField(max_digits=5, decimal_places=2, required=False, allow_null=True)
    amount = serializers.DecimalField(max_digits=10, decimal_places=2, required=False, allow_null=True)
    scope = serializers.ChoiceField(choices=["court", "total"], default="total")
    note = serializers.CharField(max_length=120, required=False, allow_blank=True, default="")


class BookingCreateSerializer(serializers.Serializer):
    court = serializers.PrimaryKeyRelatedField(queryset=Court.objects.none())
    start_at = serializers.DateTimeField()
    end_at = serializers.DateTimeField()
    customer_name = serializers.CharField(max_length=120)
    customer_phone = serializers.CharField(
        max_length=32, required=False, allow_blank=True, default=""
    )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        user = _user_from(self)
        if user is not None:
            # A user can only book courts of clubs they work at. Anything else
            # looks like "court does not exist", so other clubs stay invisible.
            self.fields["court"].queryset = Court.objects.filter(
                club__in=clubs_of(user)
            ).select_related("club")


class BookingChangeSerializer(serializers.Serializer):
    start_at = serializers.DateTimeField(required=False)
    end_at = serializers.DateTimeField(required=False)
    customer_name = serializers.CharField(max_length=120, required=False)
    customer_phone = serializers.CharField(max_length=32, required=False, allow_blank=True)


class OpenSessionStartSerializer(BookingCreateSerializer):
    start_at = None
    end_at = None


class WeeklyBookingSerializer(BookingCreateSerializer):
    weeks = serializers.IntegerField(min_value=1, max_value=52)
    dry_run = serializers.BooleanField(default=False, help_text="Only check which weeks are free.")


class WeeklyWeekSerializer(serializers.Serializer):
    start_at = serializers.DateTimeField()
    end_at = serializers.DateTimeField()
    price = serializers.DecimalField(allow_null=True, **MONEY)
    ok = serializers.BooleanField()
    code = serializers.CharField(allow_null=True)
    detail = serializers.CharField(allow_null=True)


class WeeklyResultSerializer(serializers.Serializer):
    created = BookingSerializer(many=True)
    skipped = WeeklyWeekSerializer(many=True)


class ItemAddSerializer(serializers.Serializer):
    product = serializers.PrimaryKeyRelatedField(queryset=Product.objects.all())
    quantity = serializers.IntegerField(min_value=1, max_value=99, default=1)


class ItemQuantitySerializer(serializers.Serializer):
    quantity = serializers.IntegerField(min_value=0, max_value=99)


class PaymentAddSerializer(serializers.ModelSerializer):
    class Meta:
        model = Payment
        fields = ("amount", "method", "payer_name")


class QuoteSerializer(serializers.Serializer):
    start = serializers.DateTimeField()
    end = serializers.DateTimeField()
    price = serializers.DecimalField(max_digits=10, decimal_places=2, read_only=True)


class RevenueByCourtSerializer(serializers.Serializer):
    court = serializers.IntegerField()
    court_name = serializers.CharField()
    total = serializers.DecimalField(max_digits=12, decimal_places=2)
    bookings = serializers.IntegerField()


class RevenueByDaySerializer(serializers.Serializer):
    date = serializers.DateField()
    total = serializers.DecimalField(max_digits=12, decimal_places=2)
    buffet = serializers.DecimalField(max_digits=12, decimal_places=2)
    discounts = serializers.DecimalField(max_digits=12, decimal_places=2)
    bookings = serializers.IntegerField()


class RevenueReportSerializer(serializers.Serializer):
    club = serializers.IntegerField()
    currency = serializers.CharField()
    timezone = serializers.CharField()
    date_from = serializers.DateField()
    date_to = serializers.DateField()
    total = serializers.DecimalField(max_digits=12, decimal_places=2, help_text="Court time")
    buffet_total = serializers.DecimalField(max_digits=12, decimal_places=2)
    discount_total = serializers.DecimalField(max_digits=12, decimal_places=2)
    grand_total = serializers.DecimalField(
        max_digits=12, decimal_places=2, help_text="Court time + buffet - discounts"
    )
    bookings = serializers.IntegerField()
    by_court = RevenueByCourtSerializer(many=True)
    by_day = RevenueByDaySerializer(many=True)


class ProductSerializer(serializers.ModelSerializer):
    class Meta:
        model = Product
        fields = ("id", "club", "name", "category", "price", "is_active")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        user = _user_from(self)
        if user is not None:
            self.fields["club"].queryset = clubs_of(user)

    def validate_club(self, club):
        if self.instance is not None and club != self.instance.club:
            raise serializers.ValidationError("A product cannot move to another club.")
        return club

    def validate_price(self, price):
        if price < 0:
            raise serializers.ValidationError("Price cannot be negative.")
        return price


class CustomerCategorySerializer(serializers.ModelSerializer):
    customers = serializers.IntegerField(source="customers_count", read_only=True, default=0)

    class Meta:
        model = CustomerCategory
        fields = ("id", "club", "name", "color", "discount_percent", "customers")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        user = _user_from(self)
        if user is not None:
            self.fields["club"].queryset = clubs_of(user)

    def validate_club(self, club):
        if self.instance is not None and club != self.instance.club:
            raise serializers.ValidationError("A category cannot move to another club.")
        return club

    def validate_color(self, color):
        if len(color) != 7 or not color.startswith("#"):
            raise serializers.ValidationError("Use a colour like #1d6fd1.")
        return color


class DiscountSettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = DiscountSettings
        fields = (
            "first_visit_enabled",
            "first_visit_percent",
            "nth_visit_enabled",
            "nth_visit_every",
            "nth_visit_percent",
        )


class CustomerSerializer(serializers.ModelSerializer):
    category_name = serializers.CharField(source="category.name", read_only=True, default=None)
    category_color = serializers.CharField(source="category.color", read_only=True, default=None)
    visits = serializers.IntegerField(read_only=True, default=0)
    no_shows = serializers.IntegerField(read_only=True, default=0)
    spent = serializers.DecimalField(read_only=True, default=0, **MONEY)
    last_visit = serializers.DateTimeField(read_only=True, default=None)

    class Meta:
        model = Customer
        fields = (
            "id",
            "club",
            "name",
            "phone",
            "category",
            "category_name",
            "category_color",
            "notes",
            "created_at",
            "visits",
            "no_shows",
            "spent",
            "last_visit",
        )
        read_only_fields = ("id", "created_at")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        user = _user_from(self)
        if user is not None:
            self.fields["club"].queryset = clubs_of(user)
            self.fields["category"].queryset = CustomerCategory.objects.filter(club__in=clubs_of(user))

    def validate_club(self, club):
        if self.instance is not None and club != self.instance.club:
            raise serializers.ValidationError("A customer cannot move to another club.")
        return club

    def validate(self, attrs):
        club = attrs.get("club") or getattr(self.instance, "club", None)
        category = attrs.get("category")
        if category is not None and category.club_id != club.pk:
            raise serializers.ValidationError({"category": "This category belongs to another club."})
        phone = normalize_phone(attrs.get("phone", getattr(self.instance, "phone", "")))
        if phone:
            clash = Customer.objects.filter(club=club, phone=phone)
            if self.instance is not None:
                clash = clash.exclude(pk=self.instance.pk)
            if clash.exists():
                raise serializers.ValidationError(
                    {"phone": "Another customer already has this phone."}
                )
        return attrs


class StaffSerializer(serializers.ModelSerializer):
    username = serializers.CharField(source="user.username", read_only=True)
    full_name = serializers.SerializerMethodField()
    last_login = serializers.DateTimeField(source="user.last_login", read_only=True)

    class Meta:
        model = Membership
        fields = ("id", "club", "user", "username", "full_name", "role", "last_login")
        read_only_fields = ("id", "club", "user", "username", "full_name", "last_login")

    def get_full_name(self, membership) -> str:
        return membership.user.get_full_name()


class StaffCreateSerializer(serializers.Serializer):
    club = serializers.PrimaryKeyRelatedField(queryset=Club.objects.none())
    username = serializers.CharField(max_length=150)
    password = serializers.CharField(
        required=False,
        allow_blank=True,
        write_only=True,
        help_text="Required when the username does not exist yet.",
    )
    first_name = serializers.CharField(max_length=150, required=False, allow_blank=True)
    role = serializers.ChoiceField(choices=Membership.Role.choices)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        user = _user_from(self)
        if user is not None:
            self.fields["club"].queryset = clubs_of(user)


class DailyReportSerializer(serializers.Serializer):
    club = serializers.IntegerField()
    date = serializers.DateField()
    currency = serializers.CharField()
    received = serializers.DecimalField(**MONEY)
    by_method = serializers.ListField(child=serializers.DictField())
    buffet = serializers.ListField(child=serializers.DictField())
    buffet_total = serializers.DecimalField(**MONEY)
    discount_total = serializers.DecimalField(**MONEY)
    bookings = serializers.IntegerField()
    unpaid = BookingSerializer(many=True)
    unpaid_total = serializers.DecimalField(**MONEY)

