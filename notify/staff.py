"""Tell the club's staff about things customers do online: in the admin site, and in their Telegram group."""

from . import telegram
from .models import Notification

# Which notifications also go to the staff Telegram group, with which text.
TELEGRAM_KEYS = {
    Notification.Kind.ONLINE_BOOKING: "staff_new",
    Notification.Kind.ONLINE_CANCELLED: "staff_cancelled",
}


def announce(booking, kind, **extra):
    club = booking.court.club
    paid = sum((p.amount for p in booking.payments.all()), 0)
    notification = Notification.objects.create(
        club=club,
        kind=kind,
        booking=booking,
        data={
            "customer_name": booking.customer_name,
            "customer_phone": booking.customer_phone,
            "court": booking.court.name,
            "start_at": booking.start_at.isoformat(),
            "end_at": booking.end_at.isoformat(),
            "price": f"{booking.price:.2f}",
            "paid": f"{paid:.2f}",
            **extra,
        },
    )
    if kind in TELEGRAM_KEYS:
        telegram.notify_staff(booking, TELEGRAM_KEYS[kind])
    return notification
