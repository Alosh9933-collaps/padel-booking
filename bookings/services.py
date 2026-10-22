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

    for moment in (local_start, local_end):
        if moment.second or moment.microsecond or moment.minute % club.slot_minutes:
            raise InvalidBookingTime(
                f"Times must fall on a {club.slot_minutes}-minute grid."
            )

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
    club = court.club
    tz = ZoneInfo(club.timezone)
    rules = list(
        PriceRule.objects.filter(club=club).filter(Q(court=court) | Q(court__isnull=True))
    )
    step = timedelta(minutes=club.slot_minutes)
    step_fraction = Decimal(club.slot_minutes) / Decimal(60)

    total = Decimal("0")
    cursor = start_at
    while cursor < end_at:
        rule = _pick_rule(rules, court, cursor.astimezone(tz))
        if rule is None:
            raise PriceNotConfigured(
                f"No price rule covers {cursor.astimezone(tz):%A %H:%M} for {court.name}."
            )
        total += rule.price_per_hour * step_fraction
        cursor += step
    return total.quantize(Decimal("0.01"))


def create_booking(*, court, start_at, end_at, customer_name, customer_phone="", created_by=None):
    validate_window(court, start_at, end_at)
    price = calculate_price(court, start_at, end_at)
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
            return Booking.objects.create(
                court=court,
                start_at=start_at,
                end_at=end_at,
                customer_name=customer_name,
                customer_phone=customer_phone,
                price=price,
                created_by=created_by,
            )
    except IntegrityError as exc:
        if "booking_no_overlap" in str(exc):
            raise SlotUnavailable("This time slot is already booked.") from exc
        raise


def cancel_booking(booking):
    if booking.status == Booking.Status.CANCELLED:
        return booking
    booking.status = Booking.Status.CANCELLED
    booking.cancelled_at = timezone.now()
    booking.save(update_fields=["status", "cancelled_at"])
    return booking