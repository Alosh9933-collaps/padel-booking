from django.contrib import admin

from .models import BalanceEntry, TopUpPlan


@admin.register(TopUpPlan)
class TopUpPlanAdmin(admin.ModelAdmin):
    list_display = ("name", "club", "price", "credit", "is_active")


@admin.register(BalanceEntry)
class BalanceEntryAdmin(admin.ModelAdmin):
    list_display = ("created_at", "customer", "kind", "amount", "paid", "method")
    list_filter = ("club", "kind")
