from datetime import datetime, time, timedelta
from datetime import timezone as dt_timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

from .models import Booking
from .services import PriceNotConfigured, _club_window, _pick_rule, calculate_price, court_price_rules


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

    rules = court_price_rules(court)
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


def free_starts(court, day, minutes, not_before=None, mark=10):
    """Where a game of `minutes` fits on one court and day, with the exact price.

    Start times are the schedule grid (every slot_minutes from opening) plus the
    moments other bookings end, so the gap after an odd-length game can be filled
    too. Only starts on a `mark`-minute boundary, and after `not_before`, count.
    """
    if not court.is_active:
        return []

    club = court.club
    tz = ZoneInfo(club.timezone)
    open_dt, close_dt = _club_window(club, datetime.combine(day, time(0), tzinfo=tz))
    open_utc, close_utc = open_dt.astimezone(dt_timezone.utc), close_dt.astimezone(dt_timezone.utc)
    length = timedelta(minutes=minutes)
    rules = court_price_rules(court)
    bookings = list(
        Booking.objects.filter(
            court=court, status=Booking.Status.CONFIRMED, start_at__lt=close_dt, end_at__gt=open_dt
        ).only("start_at", "end_at")
    )

    starts = set()
    cursor = open_utc
    while cursor < close_utc:
        starts.add(cursor)
        cursor += timedelta(minutes=club.slot_minutes)
    starts.update(b.end_at for b in bookings if open_utc <= b.end_at < close_utc)

    found = []
    for start in sorted(starts):
        end = start + length
        local = start.astimezone(tz)
        if end > close_utc or local.minute % mark or local.second:
            continue
        if not_before is not None and start <= not_before:
            continue
        if any(b.start_at < end and b.end_at > start for b in bookings):
            continue
        try:
            price = calculate_price(court, start, end, rules)
        except PriceNotConfigured:
            continue
        found.append({"start": local, "end": end.astimezone(tz), "price": price})
    return found
