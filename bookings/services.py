import uuid
from datetime import datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.db import IntegrityError, connection, transaction
from django.db.models import Q
from django.utils import timezone

from clubs.models import Customer, PriceRule, normalize_phone

from .discounts import refresh_discount
from .models import Booking

# First key of the two-key Postgres advisory lock taken per court while booking.
COURT_LOCK_NAMESPACE = 7201
MAX_WEEKS = 52


class BookingError(Exception):
    """Base class for expected, user-facing booking problems.

    `code` is stable and machine-readable, so the frontend can show the
    message in the user's language; the text itself is English.
    """

    code = "booking_error"

    def __init__(self, message, code=None):
        super().__init__(message)
        if code:
            self.code = code


class InvalidBookingTime(BookingError):
    code = "invalid_time"


class SlotUnavailable(BookingError):
    code = "slot_unavailable"


class PriceNotConfigured(BookingError):
    code = "price_not_configured"


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
        raise InvalidBookingTime("Start and end must be timezone-aware datetimes.", "naive_time")
    if end_at <= start_at:
        raise InvalidBookingTime("End must be after start.", "end_before_start")
    if not court.is_active:
        raise InvalidBookingTime("This court is not active.", "court_inactive")

    tz = ZoneInfo(club.timezone)
    local_start = start_at.astimezone(tz)
    local_end = end_at.astimezone(tz)

    # Any minute is allowed; the club's slot_minutes only shapes the schedule view.
    for moment in (local_start, local_end):
        if moment.second or moment.microsecond:
            raise InvalidBookingTime("Times must be whole minutes.", "whole_minutes")

    open_dt, close_dt = _club_window(club, local_start)
    if local_start < open_dt or local_end > close_dt:
        raise InvalidBookingTime("The booking is outside the club's opening hours.", "outside_hours")


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


def resolve_customer(club, name, phone):
    """The club's customer with this phone, created on first visit. None without a phone."""
    phone = normalize_phone(phone)
    if not phone:
        return None
    customer, created = Customer.objects.get_or_create(
        club=club, phone=phone, defaults={"name": name}
    )
    if not created and not customer.name:
        customer.name = name
        customer.save(update_fields=["name"])
    return customer


def _lock_court(court_id):
    # Parallel inserts checking the same exclusion constraint can deadlock.
    # Queueing writes per court avoids that; the constraint still decides.
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(%s, %s)", [COURT_LOCK_NAMESPACE, court_id])


def _insert_booking(court, **fields):
    try:
        # The inner atomic() makes this a savepoint, so a rejected insert never
        # poisons an outer transaction (for example the one a request runs in).
        with transaction.atomic():
            _lock_court(court.pk)
            return Booking.objects.create(court=court, **fields)
    except IntegrityError as exc:
        if "booking_no_overlap" in str(exc):
            raise SlotUnavailable("This time slot is already booked.") from exc
        raise


def create_booking(
    *,
    court,
    start_at,
    end_at,
    customer_name,
    customer_phone="",
    created_by=None,
    customer=None,
    series=None,
):
    validate_window(court, start_at, end_at)
    return _insert_booking(
        court,
        start_at=start_at,
        end_at=end_at,
        customer=customer or resolve_customer(court.club, customer_name, customer_phone),
        customer_name=customer_name,
        customer_phone=customer_phone,
        price=calculate_price(court, start_at, end_at),
        created_by=created_by,
        series=series,
    )


def change_booking(
    booking, *, start_at=None, end_at=None, court=None, customer_name=None, customer_phone=None
):
    """Move (in time or to another court), extend or shorten a confirmed booking, or fix the customer details.

    A new time or court is re-priced with the current price rules. The overlap
    constraint still guards the update, so moving into another booking fails.
    """
    if booking.status != Booking.Status.CONFIRMED:
        raise BookingError("Only a confirmed booking can be changed.", "booking_closed")
    if court is not None and court.club_id != booking.court.club_id:
        raise BookingError("A booking cannot move to another club.", "court_inactive")
    if booking.is_open and (start_at or end_at or (court is not None and court != booking.court)):
        raise BookingError(
            "Open play has no end time yet. Stop it first, then change it.", "open_play_running"
        )

    fields = []
    if customer_name is not None:
        booking.customer_name = customer_name
        fields.append("customer_name")
    if customer_phone is not None and customer_phone != booking.customer_phone:
        booking.customer_phone = customer_phone
        booking.customer = resolve_customer(
            booking.court.club, booking.customer_name, customer_phone
        )
        fields += ["customer_phone", "customer"]

    new_start = start_at or booking.start_at
    new_end = end_at or booking.end_at
    new_court = court or booking.court
    old_court_id = booking.court_id
    if (new_start, new_end, new_court.pk) != (booking.start_at, booking.end_at, old_court_id):
        validate_window(new_court, new_start, new_end)
        booking.start_at, booking.end_at, booking.court = new_start, new_end, new_court
        booking.price = calculate_price(new_court, new_start, new_end)
        fields += ["start_at", "end_at", "court", "price"]

    if not fields:
        return booking
    try:
        with transaction.atomic():
            # Lock both courts in a fixed order, so two opposite moves cannot deadlock.
            for court_id in sorted({old_court_id, booking.court_id}):
                _lock_court(court_id)
            booking.save(update_fields=fields)
            refresh_discount(booking)
    except IntegrityError as exc:
        if "booking_no_overlap" in str(exc):
            booking.refresh_from_db()
            raise SlotUnavailable(
                "The new time overlaps another booking on this court.", "overlap_on_change"
            ) from exc
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
        raise InvalidBookingTime(
            "The club is closing; there is no time left for open play.", "club_closing"
        )
    validate_window(court, start_at, close_dt)
    # Fail now rather than at stop time if part of the session has no price.
    calculate_price(court, start_at, close_dt)
    try:
        return _insert_booking(
            court,
            start_at=start_at,
            end_at=close_dt,
            is_open=True,
            customer=resolve_customer(court.club, customer_name, customer_phone),
            customer_name=customer_name,
            customer_phone=customer_phone,
            price=Decimal("0"),
            created_by=created_by,
        )
    except SlotUnavailable as exc:
        raise SlotUnavailable(
            "This court is already booked later today, so open play cannot start. "
            "Open play holds the court until closing time.",
            "open_play_conflict",
        ) from exc


def stop_open_session(booking):
    """End open play now and charge the exact minutes played."""
    if not booking.is_open or booking.status != Booking.Status.CONFIRMED:
        raise BookingError("This booking is not a running open session.", "not_open_play")
    # Never shorter than one minute, never past the hold (closing time).
    end_at = min(max(_this_minute(), booking.start_at + timedelta(minutes=1)), booking.end_at)
    booking.end_at = end_at
    booking.price = calculate_price(booking.court, booking.start_at, end_at)
    booking.is_open = False
    booking.save(update_fields=["end_at", "price", "is_open"])
    # A percent discount applied while playing becomes real money now.
    return refresh_discount(booking)


def cancel_booking(booking):
    if booking.status == Booking.Status.CANCELLED:
        return booking
    booking.status = Booking.Status.CANCELLED
    booking.cancelled_at = timezone.now()
    booking.save(update_fields=["status", "cancelled_at"])
    return booking


def mark_no_show(booking):
    """The customer never came. The booking stays on record but frees the court."""
    if booking.status != Booking.Status.CONFIRMED or booking.is_open:
        raise BookingError("Only a confirmed, finished-time booking can be a no-show.", "booking_closed")
    if booking.start_at > timezone.now():
        raise BookingError("A booking can be marked as a no-show only after it starts.", "no_show_too_early")
    booking.status = Booking.Status.NO_SHOW
    booking.save(update_fields=["status"])
    return booking


def _weekly_times(court, start_at, end_at, weeks):
    """The same local wall-clock time, week after week (safe across DST changes)."""
    tz = ZoneInfo(court.club.timezone)
    local_start = start_at.astimezone(tz)
    length = end_at - start_at
    for week in range(weeks):
        day = local_start.date() + timedelta(weeks=week)
        start = datetime.combine(day, local_start.time(), tzinfo=tz)
        yield start, start + length


def plan_weekly(*, court, start_at, end_at, weeks):
    """Which weeks of a series can be booked, without booking anything."""
    if not 1 <= weeks <= MAX_WEEKS:
        raise BookingError(f"Choose between 1 and {MAX_WEEKS} weeks.", "weeks_out_of_range")
    plan = []
    for start, end in _weekly_times(court, start_at, end_at, weeks):
        entry = {"start_at": start, "end_at": end, "price": None, "ok": True, "code": None, "detail": None}
        try:
            validate_window(court, start, end)
            entry["price"] = calculate_price(court, start, end)
            taken = Booking.objects.filter(
                court=court, status=Booking.Status.CONFIRMED, start_at__lt=end, end_at__gt=start
            ).exists()
            if taken:
                raise SlotUnavailable("This time slot is already booked.")
        except BookingError as exc:
            entry.update(ok=False, code=exc.code, detail=str(exc))
        plan.append(entry)
    return plan


def create_weekly(*, court, start_at, end_at, weeks, customer_name, customer_phone="", created_by=None):
    """Book the same time every week. Weeks that cannot be booked are skipped, not fatal."""
    if not 1 <= weeks <= MAX_WEEKS:
        raise BookingError(f"Choose between 1 and {MAX_WEEKS} weeks.", "weeks_out_of_range")
    series = uuid.uuid4()
    customer = resolve_customer(court.club, customer_name, customer_phone)
    created, skipped = [], []
    for start, end in _weekly_times(court, start_at, end_at, weeks):
        try:
            created.append(
                create_booking(
                    court=court,
                    start_at=start,
                    end_at=end,
                    customer_name=customer_name,
                    customer_phone=customer_phone,
                    created_by=created_by,
                    customer=customer,
                    series=series,
                )
            )
        except BookingError as exc:
            skipped.append({"start_at": start, "end_at": end, "code": exc.code, "detail": str(exc)})
    return created, skipped


def cancel_following(booking):
    """Cancel this booking and every later confirmed booking of its weekly series."""
    if booking.series is None:
        return [cancel_booking(booking)]
    later = Booking.objects.filter(
        series=booking.series, status=Booking.Status.CONFIRMED, start_at__gte=booking.start_at
    )
    return [cancel_booking(b) for b in later]
