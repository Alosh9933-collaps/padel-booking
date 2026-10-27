"""Prepayment for online bookings.

The booking is made first and holds its court for HOLD_MINUTES while the
customer pays on the provider's page. sync() asks the provider how it went:
paid puts the money on the bill and tells the staff; not paid, or no answer
before the hold runs out, frees the court again. A payment that arrives after
the court was freed is refunded. Every step is safe to repeat.
"""

from datetime import timedelta
from decimal import ROUND_HALF_UP, Decimal
from zoneinfo import ZoneInfo

from django.db import transaction
from django.utils import timezone

from bookings.billing import add_refund
from bookings.models import Booking, Payment
from bookings.services import BookingError, cancel_booking
from cashdesk.services import record
from notify.models import Notification
from notify.staff import announce

from . import providers
from .models import OnlinePayment

HOLD_MINUTES = 15
CENT = Decimal("0.01")


def prepay_amount(booking):
    """The share of the price the club wants paid up front."""
    percent = booking.court.club.online_prepay_percent
    return (booking.price * percent / Decimal(100)).quantize(CENT, rounding=ROUND_HALF_UP)


def provider_for(club):
    """The provider to use, or a clear error when the club wants prepayment but none is set up."""
    provider = providers.active()
    if provider is None and club.online_prepay_percent:
        raise BookingError("Online payment is not set up yet. Please call the club to book.", "payments_not_configured")
    return provider


def start(booking, return_url):
    """Open a payment for the booking's prepayment. The booking must already hold its court."""
    club = booking.court.club
    provider = provider_for(club)
    payment = OnlinePayment.objects.create(booking=booking, provider=provider.name, amount=prepay_amount(booking))
    when = booking.start_at.astimezone(ZoneInfo(club.timezone))
    description = f"{club.name}: {booking.court.name}, {when:%d.%m.%Y %H:%M}"
    payment.provider_id, payment.confirmation_url = provider.create(payment, description=description, return_url=return_url)
    payment.save(update_fields=["provider_id", "confirmation_url"])
    return payment


def hold_until():
    return timezone.now() + timedelta(minutes=HOLD_MINUTES)


def sync(payment):
    """Ask the provider how the payment went and act on it."""
    if payment.status != OnlinePayment.Status.PENDING:
        return payment
    state = providers.of(payment).status(payment)
    if state == OnlinePayment.Status.SUCCEEDED:
        return succeeded(payment)
    if state == OnlinePayment.Status.CANCELED:
        return canceled(payment)
    return payment


@transaction.atomic
def succeeded(payment):
    """The money came in: confirm the booking, or refund when its court was already freed."""
    payment = OnlinePayment.objects.select_for_update().get(pk=payment.pk)
    if payment.status != OnlinePayment.Status.PENDING:
        return payment  # another request got here first
    payment.status = OnlinePayment.Status.SUCCEEDED
    payment.paid_at = timezone.now()
    payment.save(update_fields=["status", "paid_at"])

    booking = Booking.objects.select_for_update().select_related("court__club").get(pk=payment.booking_id)
    if booking.status == Booking.Status.CONFIRMED:
        # The money is already in, so the bill takes all of it even if staff lowered the price
        # meanwhile (add_payment would refuse that as an overpayment); any surplus shows as owed back.
        Payment.objects.create(
            booking=booking, amount=payment.amount, method=Payment.Method.ONLINE, payer_name=booking.customer_name
        )
        booking.hold_until = None
        booking.save(update_fields=["hold_until"])
        record(
            booking.court.club,
            None,
            "payment.added",
            booking=booking,
            amount=payment.amount,
            customer=booking.customer_name,
            method=Payment.Method.ONLINE,
        )
        announce(booking, Notification.Kind.ONLINE_BOOKING)
    else:
        refund(payment, payment.amount)
        announce(booking, Notification.Kind.LATE_PAYMENT, amount=f"{payment.amount:.2f}")
    return payment


@transaction.atomic
def canceled(payment):
    """The customer did not pay: free the court right away."""
    payment = OnlinePayment.objects.select_for_update().get(pk=payment.pk)
    if payment.status != OnlinePayment.Status.PENDING:
        return payment
    payment.status = OnlinePayment.Status.CANCELED
    payment.save(update_fields=["status"])
    booking = Booking.objects.select_for_update().get(pk=payment.booking_id)
    if booking.status == Booking.Status.CONFIRMED and booking.hold_until is not None:
        cancel_booking(booking)
    return payment


def refund(payment, amount):
    providers.of(payment).refund(payment, amount)
    payment.refunded += amount
    payment.save(update_fields=["refunded"])


def refund_to_customer(booking, reason):
    """Give back everything prepaid online for a cancelled booking, and put it on the bill."""
    for payment in booking.online_payments.select_for_update().filter(status=OnlinePayment.Status.SUCCEEDED):
        left = payment.amount - payment.refunded
        if left > 0:
            refund(payment, left)
            add_refund(booking, left, Payment.Method.ONLINE, reason=reason)


def release_expired_holds():
    """Free the courts of online bookings whose prepayment did not come in time."""
    now = timezone.now()
    for booking in Booking.objects.filter(status=Booking.Status.CONFIRMED, hold_until__lt=now):
        for payment in booking.online_payments.filter(status=OnlinePayment.Status.PENDING):
            try:
                sync(payment)  # it may have been paid a moment ago
            except BookingError:
                pass  # the provider is not answering; the hold still ends
        with transaction.atomic():
            booking = Booking.objects.select_for_update().get(pk=booking.pk)
            if booking.status == Booking.Status.CONFIRMED and booking.hold_until is not None and booking.hold_until < now:
                cancel_booking(booking)
