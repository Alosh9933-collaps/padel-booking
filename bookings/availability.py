from datetime import datetime, time, timedelta
from datetime import timezone as dt_timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.db.models import Q

from clubs.models import PriceRule

from .models import Booking
from .services import _club_window, _pick_rule


def get_availability(court, day):
    """All slots of one court on one calendar day, in the club's own timezone.

    A slot is available when no confirmed booking overlaps it and a price
    rule covers it.
    """
    if not court.is_active:
        return []

    club = court.club
    tz = ZoneInfo(club.timezone)
    open_dt, close_dt = _club_window(club, datetime.combine(day, time(0), tzinfo=tz))

    rules = list(
        PriceRule.objects.filter(club=club).filter(Q(court=court) | Q(court__isnull=True))
    )
    bookings = list(
        Booking.objects.filter(
            court=court,
            status=Booking.Status.CONFIRMED,
            start_at__lt=close_dt,
            end_at__gt=open_dt,
        )
    )

    step = timedelta(minutes=club.slot_minutes)
    step_fraction = Decimal(club.slot_minutes) / Decimal(60)
    cursor = open_dt.astimezone(dt_timezone.utc)
    close_utc = close_dt.astimezone(dt_timezone.utc)

    slots = []
    while cursor < close_utc:
        end = cursor + step
        rule = _pick_rule(rules, court, cursor.astimezone(tz))
        price = (rule.price_per_hour * step_fraction).quantize(Decimal("0.01")) if rule else None
        booked = any(b.start_at < end and b.end_at > cursor for b in bookings)
        slots.append(
            {
                "start": cursor.astimezone(tz),
                "end": end.astimezone(tz),
                "available": (not booked) and price is not None,
                "price": price,
            }
        )
        cursor = end
    return slots