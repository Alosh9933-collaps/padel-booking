from django import forms
from django.contrib import admin
from django.utils import timezone

from .models import Booking
from .services import BookingError, calculate_price, validate_window


class BookingAdminForm(forms.ModelForm):
    """Runs the same opening-hours and pricing rules as bookings.services."""

    class Meta:
        model = Booking
        fields = ("court", "start_at", "end_at", "customer_name", "customer_phone", "status")

    def clean(self):
        cleaned = super().clean()
        court = cleaned.get("court")
        start_at = cleaned.get("start_at")
        end_at = cleaned.get("end_at")
        if court and start_at and end_at:
            try:
                validate_window(court, start_at, end_at)
                self.instance.price = calculate_price(court, start_at, end_at)
            except BookingError as exc:
                raise forms.ValidationError(str(exc))
        return cleaned


@admin.register(Booking)
class BookingAdmin(admin.ModelAdmin):
    form = BookingAdminForm
    list_display = ("court", "start_at", "end_at", "customer_name", "price", "status")
    list_filter = ("status", "court__club", "court")
    search_fields = ("customer_name", "customer_phone")
    readonly_fields = ("price", "created_by", "created_at", "cancelled_at")

    def save_model(self, request, obj, form, change):
        if not change:
            obj.created_by = request.user
        if obj.status == Booking.Status.CANCELLED and obj.cancelled_at is None:
            obj.cancelled_at = timezone.now()
        super().save_model(request, obj, form, change)