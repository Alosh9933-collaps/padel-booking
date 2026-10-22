from datetime import datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.db import IntegrityError, connection, transaction
from django.db.models import Q
from django.utils import timezone

from clubs.models import PriceRule

from .models import Booking

# First key of the two-key Postgres advisory lock taken per court while booking.
COURT_LOCK_NAMESPACE = 7201


class BookingError(Exception):
    """Base class for expected, user-facing booking problems."""


class InvalidBookingTime(BookingError):
    pass


class SlotUnavailable(BookingError):
    pass


class PriceNotConfigured(BookingError):
    pass


def _club_window(club, local_start):
    """Opening and closing moments of the club on the day of local_start."""
    tz = local_start.tzinfo
    day = local_start.date()
    open_dt = datetime.combine(day, time(club.opening_hour), tzinfo=tz)
    if club.closing_hour == 24:
        close_dt = datetime.combine(day + timedelta(days=1), time(0), tzinfo=tz)
    else:
        close_dt = datetime.combine(day, time(club.closing_hour), tzinfo=tz)
    return open_dt, close_dt


def validate_window(court, start_at, end_at):
    club = court.club
    if timezone.is_naive(start_at) or timezone.is_naive(end_at):
        raise InvalidBookingTime("Start and end must be timezone-aware datetimes.")
    if end_at <= start_at:
        raise InvalidBookingTime("End must be after start.")
    if not court.is_active:
        raise InvalidBookingTime("This court is not active.")

    tz = ZoneInfo(club.timezone)
    local_start = start_at.astimezone(tz)
    local_end = end_at.astimezone(tz)

    # Any minute is allowed; the club's slot_minutes only shapes the schedule view.
    for moment in (local_start, local_end):
        if moment.second or moment.microsecond:
            raise InvalidBookingTime("Times must be whole minutes.")

    open_dt, close_dt = _club_window(club, local_start)
    if local_start < open_dt or local_end > close_dt:
        raise InvalidBookingTime("The booking is outside the club's opening hours.")


def _pick_rule(rules, court, local_moment):
    matching = [
        r
        for r in rules
        if local_moment.weekday() in r.days_of_week
        and r.start_hour <= local_moment.hour < r.end_hour
    ]
    if not matching:
        return None
    # Highest priority first; on a tie, a court-specific rule beats a club-wide one.
    return max(matching, key=lambda r: (r.priority, r.court_id == court.pk))


def calculate_price(court, start_at, end_at):
    """Price by the minute. Rules cover whole hours, so the range is walked hour by hour."""
    club = court.club
    tz = ZoneInfo(club.timezone)
    rules = list(
        PriceRule.objects.filter(club=club).filter(Q(court=court) | Q(court__isnull=True))
    )

    total = Decimal("0")
    cursor = start_at
    while cursor < end_at:
        local = cursor.astimezone(tz)
        rule = _pick_rule(rules, court, local)
        if rule is None:
            raise PriceNotConfigured(
                f"No price rule covers {local:%A %H:%M} for {court.name}."
            )
        next_hour = local.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
        segment_end = min(end_at, next_hour)
        minutes = Decimal((segment_end - cursor).total_seconds()) / Decimal(60)
        total += rule.price_per_hour * minutes / Decimal(60)
        cursor = segment_end
    return total.quantize(Decimal("0.01"))


def _insert_booking(court, **fields):
    try:
        # The inner atomic() makes this a savepoint, so a rejected insert never
        # poisons an outer transaction (for example the one a request runs in).
        with transaction.atomic():
            # Parallel inserts checking the same exclusion constraint can deadlock.
            # Queueing bookings per court avoids that; the constraint still decides.
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT pg_advisory_xact_lock(%s, %s)", [COURT_LOCK_NAMESPACE, court.pk]
                )
            return Booking.objects.create(court=court, **fields)
    except IntegrityError as exc:
        if "booking_no_overlap" in str(exc):
            raise SlotUnavailable("This time slot is already booked.") from exc
        raise


def create_booking(*, court, start_at, end_at, customer_name, customer_phone="", created_by=None):
    validate_window(court, start_at, end_at)
    return _insert_booking(
        court,
        start_at=start_at,
        end_at=end_at,
        customer_name=customer_name,
        customer_phone=customer_phone,
        price=calculate_price(court, start_at, end_at),
        created_by=created_by,
    )


def change_booking(booking, *, start_at=None, end_at=None, customer_name=None, customer_phone=None):
    """Move, extend or shorten a confirmed booking, or fix the customer details.

    A new time is re-priced with the current price rules. The overlap
    constraint still guards the update, so extending into another booking fails.
    """
    if booking.status != Booking.Status.CONFIRMED:
        raise BookingError("A cancelled booking cannot be changed.")
    if booking.is_open and (start_at or end_at):
        raise BookingError("Open play has no end time yet. Stop it first, then change it.")

    fields = []
    if customer_name is not None:
        booking.customer_name = customer_name
        fields.append("customer_name")
    if customer_phone is not None:
        booking.customer_phone = customer_phone
        fields.append("customer_phone")

    new_start = start_at or booking.start_at
    new_end = end_at or booking.end_at
    if (new_start, new_end) != (booking.start_at, booking.end_at):
        validate_window(booking.court, new_start, new_end)
        booking.start_at, booking.end_at = new_start, new_end
        booking.price = calculate_price(booking.court, new_start, new_end)
        fields += ["start_at", "end_at", "price"]

    if not fields:
        return booking
    try:
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT pg_advisory_xact_lock(%s, %s)", [COURT_LOCK_NAMESPACE, booking.court_id]
                )
            booking.save(update_fields=fields)
    except IntegrityError as exc:
        if "booking_no_overlap" in str(exc):
            booking.refresh_from_db()
            raise SlotUnavailable("The new time overlaps another booking on this court.") from exc
        raise
    return booking


def _this_minute():
    return timezone.now().replace(second=0, microsecond=0)


def start_open_session(*, court, customer_name, customer_phone="", created_by=None):
    """Open play with no end time, starting now.

    Until it is stopped the court is held up to closing time, so the overlap
    constraint keeps every later booking of the day off this court. The price
    is 0 until stop_open_session() charges the minutes actually played.
    """
    start_at = _this_minute()
    tz = ZoneInfo(court.club.timezone)
    _, close_dt = _club_window(court.club, start_at.astimezone(tz))
    if close_dt - start_at < timedelta(minutes=1):
        raise InvalidBookingTime("The club is closing; there is no time left for open play.")
    validate_window(court, start_at, close_dt)
    # Fail now rather than at stop time if part of the session has no price.
    calculate_price(court, start_at, close_dt)
    try:
        return _insert_booking(
            court,
            start_at=start_at,
            end_at=close_dt,
            is_open=True,
            customer_name=customer_name,
            customer_phone=customer_phone,
            price=Decimal("0"),
            created_by=created_by,
        )
    except SlotUnavailable as exc:
        raise SlotUnavailable(
            "This court is already booked later today, so open play cannot start. "
            "Open play holds the court until closing time."
        ) from exc


def stop_open_session(booking):
    """End open play now and charge the exact minutes played."""
    if not booking.is_open or booking.status != Booking.Status.CONFIRMED:
        raise BookingError("This booking is not a running open session.")
    # Never shorter than one minute, never past the hold (closing time).
    end_at = min(max(_this_minute(), booking.start_at + timedelta(minutes=1)), booking.end_at)
    booking.end_at = end_at
    booking.price = calculate_price(booking.court, booking.start_at, end_at)
    booking.is_open = False
    booking.save(update_fields=["end_at", "price", "is_open"])
    return booking


def cancel_booking(booking):
    if booking.status == Booking.Status.CANCELLED:
        return booking
    booking.status = Booking.Status.CANCELLED
    booking.cancelled_at = timezone.now()
    booking.save(update_fields=["status", "cancelled_at"])
    return booking