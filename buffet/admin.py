from django.contrib import admin

from .models import BookingItem, Product


@admin.register(Product)
class ProductAdmin(admin.ModelAdmin):
    list_display = ("name", "club", "category", "price", "is_active")
    list_filter = ("club", "category", "is_active")


@admin.register(BookingItem)
class BookingItemAdmin(admin.ModelAdmin):
    list_display = ("booking", "name", "unit_price", "quantity", "created_at")
