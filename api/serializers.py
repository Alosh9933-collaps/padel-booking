from rest_framework import serializers

from bookings.models import Booking
from clubs.access import clubs_of
from clubs.models import Court


class CourtSerializer(serializers.ModelSerializer):
    club_name = serializers.CharField(source="club.name", read_only=True)

    class Meta:
        model = Court
        fields = ("id", "club", "club_name", "name", "kind", "is_active")
        read_only_fields = fields


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
        request = self.context.get("request")
        if request is not None and request.user.is_authenticated:
            # A user can only book courts of clubs they work at. Anything else
            # looks like "court does not exist", so other clubs stay invisible.
            self.fields["court"].queryset = Court.objects.filter(
                club__in=clubs_of(request.user)
            ).select_related("club")