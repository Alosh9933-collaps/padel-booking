from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from rest_framework import serializers

from bookings.models import Booking
from clubs.access import clubs_of
from clubs.models import Club, Court, PriceRule


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


class BookingSerializer(serializers.ModelSerializer):
    court_name = serializers.CharField(source="court.name", read_only=True)

    class Meta:
        model = Booking
        fields = (
            "id",
            "court",
            "court_name",
            "start_at",
            "end_at",
            "customer_name",
            "customer_phone",
            "price",
            "status",
            "is_open",
            "created_at",
            "cancelled_at",
        )
        read_only_fields = fields


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
    bookings = serializers.IntegerField()


class RevenueReportSerializer(serializers.Serializer):
    club = serializers.IntegerField()
    currency = serializers.CharField()
    timezone = serializers.CharField()
    date_from = serializers.DateField()
    date_to = serializers.DateField()
    total = serializers.DecimalField(max_digits=12, decimal_places=2)
    bookings = serializers.IntegerField()
    by_court = RevenueByCourtSerializer(many=True)
    by_day = RevenueByDaySerializer(many=True)
