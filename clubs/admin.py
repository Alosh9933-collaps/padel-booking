from django.contrib import admin

from .models import Club, Court, Membership, PriceRule


@admin.register(Club)
class ClubAdmin(admin.ModelAdmin):
    list_display = ("name", "timezone", "currency", "opening_hour", "closing_hour", "slot_minutes")


@admin.register(Court)
class CourtAdmin(admin.ModelAdmin):
    list_display = ("name", "club", "kind", "is_active")
    list_filter = ("club", "kind", "is_active")


@admin.register(PriceRule)
class PriceRuleAdmin(admin.ModelAdmin):
    list_display = ("club", "court", "days_of_week", "start_hour", "end_hour", "price_per_hour", "priority")
    list_filter = ("club",)


@admin.register(Membership)
class MembershipAdmin(admin.ModelAdmin):
    list_display = ("user", "club", "role")
    list_filter = ("club", "role")