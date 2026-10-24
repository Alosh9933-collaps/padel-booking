from django.contrib import admin

from .models import Activity, Shift


@admin.register(Shift)
class ShiftAdmin(admin.ModelAdmin):
    list_display = ("club", "opened_at", "opened_by", "closed_at", "expected_cash", "counted_cash")
    list_filter = ("club",)


@admin.register(Activity)
class ActivityAdmin(admin.ModelAdmin):
    list_display = ("created_at", "club", "user", "action", "booking", "amount")
    list_filter = ("club", "action")
