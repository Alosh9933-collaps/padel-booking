"""The owner's dashboard: this month against last month, busy hours, best customers."""

from calendar import monthrange
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.db.models import Count, F, Sum
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from bookings.models import Booking, Payment, Refund
from buffet.models import BookingItem, Sale
from clubs.access import can_manage, clubs_of
from clubs.models import Customer
from wallet.models import BalanceEntry

ZERO = Decimal("0.00")
HEATMAP_WEEKS = 8
TOP_CUSTOMER_DAYS = 90


def _bounds(club, first, last):
    """Aware datetimes covering the club-local days first..last."""
    tz = ZoneInfo(club.timezone)
    return datetime.combine(first, time(0), tzinfo=tz), datetime.combine(last + timedelta(days=1), time(0), tzinfo=tz)


def _open_minutes_per_day(club):
    return (club.closing_hour - club.opening_hour) * 60


def _period(club, first, last, courts):
    """Money and use of the club between two dates (inclusive)."""
    start, end = _bounds(club, first, last)
    bookings = Booking.objects.filter(
        court__club=club, status=Booking.Status.CONFIRMED, is_open=False, start_at__gte=start, start_at__lt=end
    )
    court = bookings.aggregate(s=Sum("price"), d=Sum("discount"), n=Count("id"))
    items = BookingItem.objects.filter(booking__in=bookings).aggregate(s=Sum(F("unit_price") * F("quantity")))["s"] or ZERO
    sales = Sale.objects.filter(club=club, voided_at__isnull=True, created_at__gte=start, created_at__lt=end).aggregate(
        s=Sum("total")
    )["s"] or ZERO
    booked_minutes = sum(
        (b.end_at - b.start_at).total_seconds() / 60 for b in bookings.only("start_at", "end_at")
    )
    available = _open_minutes_per_day(club) * courts * ((last - first).days + 1)
    revenue = (court["s"] or ZERO) - (court["d"] or ZERO) + items + sales
    count = court["n"] or 0
    return {
        "from": first,
        "to": last,
        "revenue": revenue,
        "court": court["s"] or ZERO,
        "buffet": items + sales,
        "discounts": court["d"] or ZERO,
        "bookings": count,
        "average": (revenue / count).quantize(Decimal("0.01")) if count else ZERO,
        "occupancy": round(booked_minutes / available * 100, 1) if available else 0,
        "new_customers": Customer.objects.filter(club=club, created_at__gte=start, created_at__lt=end).count(),
        "topups": BalanceEntry.objects.filter(
            club=club, kind=BalanceEntry.Kind.TOPUP, created_at__gte=start, created_at__lt=end
        ).aggregate(s=Sum("paid"))["s"] or ZERO,
    }


def _heatmap(club, today, courts):
    """Share of court time booked, per weekday and hour, over the last weeks."""
    tz = ZoneInfo(club.timezone)
    first = today - timedelta(weeks=HEATMAP_WEEKS) + timedelta(days=1)
    start, end = _bounds(club, first, today)
    booked = defaultdict(float)
    for b in Booking.objects.filter(
        court__club=club, status=Booking.Status.CONFIRMED, is_open=False, start_at__lt=end, end_at__gt=start
    ).only("start_at", "end_at"):
        cursor, stop = max(b.start_at, start).astimezone(tz), min(b.end_at, end).astimezone(tz)
        while cursor < stop:
            next_hour = cursor.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
            piece = min(stop, next_hour)
            booked[(cursor.weekday(), cursor.hour)] += (piece - cursor).total_seconds() / 60
            cursor = piece
    days_per_weekday = defaultdict(int)
    for i in range((today - first).days + 1):
        days_per_weekday[(first + timedelta(days=i)).weekday()] += 1
    cells = []
    for weekday in range(7):
        for hour in range(club.opening_hour, club.closing_hour):
            capacity = days_per_weekday[weekday] * courts * 60
            cells.append({
                "weekday": weekday,
                "hour": hour,
                "occupancy": round(booked[(weekday, hour)] / capacity * 100) if capacity else 0,
            })
    return {"from": first, "to": today, "cells": cells}


def _top_customers(club, today):
    start, _ = _bounds(club, today - timedelta(days=TOP_CUSTOMER_DAYS - 1), today)
    money = defaultdict(lambda: ZERO)
    for row in Payment.objects.filter(booking__customer__club=club, created_at__gte=start).values("booking__customer").annotate(s=Sum("amount")):
        money[row["booking__customer"]] += row["s"]
    for row in Refund.objects.filter(booking__customer__club=club, created_at__gte=start).values("booking__customer").annotate(s=Sum("amount")):
        money[row["booking__customer"]] -= row["s"]
    for row in Sale.objects.filter(club=club, customer__isnull=False, voided_at__isnull=True, created_at__gte=start).values("customer").annotate(s=Sum("total")):
        money[row["customer"]] += row["s"]
    visits = dict(
        Booking.objects.filter(
            customer__club=club, status=Booking.Status.CONFIRMED, start_at__gte=start, start_at__lte=timezone.now()
        )
        .values("customer")
        .annotate(n=Count("id"))
        .values_list("customer", "n")
    )
    best = sorted(set(money) | set(visits), key=lambda pk: (money.get(pk, ZERO), visits.get(pk, 0)), reverse=True)[:8]
    names = {c.pk: c for c in Customer.objects.filter(pk__in=best).select_related("category")}
    return [
        {
            "id": pk,
            "name": names[pk].name,
            "phone": names[pk].phone,
            "category_name": names[pk].category.name if names[pk].category else None,
            "category_color": names[pk].category.color if names[pk].category else None,
            "spent": money.get(pk, ZERO),
            "visits": visits.get(pk, 0),
        }
        for pk in best
        if pk in names
    ]


def _months(club, today, count=6):
    """Revenue of the last `count` calendar months, this one included (to date)."""
    out = []
    year, month = today.year, today.month
    for _ in range(count):
        first = date(year, month, 1)
        last = min(date(year, month, monthrange(year, month)[1]), today)
        period = _period(club, first, last, courts=1)
        out.append({"month": f"{year}-{month:02d}", "revenue": period["revenue"], "bookings": period["bookings"]})
        year, month = (year, month - 1) if month > 1 else (year - 1, 12)
    return list(reversed(out))


class DashboardView(APIView):
    """Owners and managers: how the club is doing."""

    @extend_schema(
        parameters=[OpenApiParameter("club", int, required=True)],
        responses=inline_serializer(
            "Dashboard",
            {
                "this_month": serializers.DictField(),
                "last_month": serializers.DictField(),
                "heatmap": serializers.DictField(),
                "top_customers": serializers.ListField(child=serializers.DictField()),
                "months": serializers.ListField(child=serializers.DictField()),
            },
        ),
        description="This month to date against the same days of last month, busy hours over 8 weeks, "
        "best customers over 90 days and revenue of the last 6 months.",
    )
    def get(self, request):
        raw = request.query_params.get("club", "")
        if not raw.isdigit():
            raise ValidationError({"club": "This parameter is required."})
        club = get_object_or_404(clubs_of(request.user), pk=int(raw))
        if not can_manage(request.user, club):
            raise PermissionDenied("Only the club's owner or manager can do this.")

        today = timezone.now().astimezone(ZoneInfo(club.timezone)).date()
        courts = max(club.courts.filter(is_active=True).count(), 1)
        first = today.replace(day=1)
        prev_last_day = first - timedelta(days=1)
        prev_first = prev_last_day.replace(day=1)
        prev_last = min(prev_first.replace(day=min(today.day, monthrange(prev_first.year, prev_first.month)[1])), prev_last_day)

        def money(period):
            return {k: (f"{v:.2f}" if isinstance(v, Decimal) else v) for k, v in period.items()}

        top = _top_customers(club, today)
        for row in top:
            row["spent"] = f"{row['spent']:.2f}"
        return Response(
            {
                "currency": club.currency,
                "this_month": money(_period(club, first, today, courts)),
                "last_month": money(_period(club, prev_first, prev_last, courts)),
                "heatmap": _heatmap(club, today, courts),
                "top_customers": top,
                "months": [{**m, "revenue": f"{m['revenue']:.2f}"} for m in _months(club, today)],
            }
        )
