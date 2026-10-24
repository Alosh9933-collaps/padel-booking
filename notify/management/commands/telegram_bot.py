"""Run the Telegram bot by long polling (no public URL needed).

    python manage.py telegram_bot

A customer who opens t.me/<bot>?start=<booking token> sends "/start <token>";
the bot links that chat to the customer and confirms the booking.
"""

import time
import uuid

from django.core.management.base import BaseCommand, CommandError

from bookings.models import Booking
from notify import telegram


def handle_message(message):
    """Reply to one incoming message. Returns the reply text (handy for tests)."""
    chat_id = message.get("chat", {}).get("id")
    text = (message.get("text") or "").strip()
    if not chat_id or not text.startswith("/start"):
        return None
    parts = text.split(maxsplit=1)
    booking = None
    if len(parts) == 2:
        try:
            booking = (
                Booking.objects.select_related("court__club", "customer")
                .filter(public_token=uuid.UUID(parts[1]))
                .first()
            )
        except ValueError:
            booking = None
    if booking is None:
        reply = telegram.TEXTS["en"]["help"] if len(parts) == 1 else telegram.TEXTS["en"]["unknown"]
    else:
        if booking.customer_id:
            booking.customer.telegram_chat_id = str(chat_id)
            booking.customer.save(update_fields=["telegram_chat_id"])
        reply = telegram.text(booking.court.club, "linked", booking=telegram.describe(booking))
    telegram.send(chat_id, reply)
    return reply


class Command(BaseCommand):
    help = "Run the Telegram bot (long polling)."

    def handle(self, *args, **options):
        if not telegram.enabled():
            raise CommandError("Set TELEGRAM_BOT_TOKEN first.")
        self.stdout.write("Telegram bot is running. Press Ctrl+C to stop.")
        offset = None
        while True:
            updates = telegram.call("getUpdates", {"timeout": 30, "offset": offset}, timeout=40) or []
            for update in updates:
                offset = update["update_id"] + 1
                if "message" in update:
                    handle_message(update["message"])
            if not updates:
                time.sleep(1)
