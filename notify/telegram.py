"""Telegram messages to customers and to the club's staff group.

Everything here is optional: without TELEGRAM_BOT_TOKEN nothing is sent.
Sending never breaks a request; a failure is logged and forgotten.
"""

import json
import logging
import threading
import urllib.request
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import transaction

log = logging.getLogger(__name__)

API = "https://api.telegram.org/bot{token}/{method}"

TEXTS = {
    "en": {
        "linked": "✅ You will get reminders for your booking here.\n\n{booking}",
        "help": "Hi! Open the Telegram link from your booking page to get reminders here.",
        "unknown": "Sorry, this booking link is not valid any more.",
        "reminder": "⏰ Reminder: your padel game starts soon.\n\n{booking}",
        "staff_new": "🌐 New online booking\n{booking}\n📞 {phone}",
        "staff_cancelled": "❌ Online booking cancelled by the customer\n{booking}\n📞 {phone}",
        "booking": "🎾 {club_name}\n{court}, {date} {start}–{end}\n💳 {price}",
    },
    "ar": {
        "linked": "✅ ستصلك تذكيرات حجزك هنا.\n\n{booking}",
        "help": "مرحبًا! افتح رابط تلغرام من صفحة حجزك لتصلك التذكيرات هنا.",
        "unknown": "عذرًا، رابط الحجز هذا لم يعد صالحًا.",
        "reminder": "⏰ تذكير: مباراة البادل تبدأ قريبًا.\n\n{booking}",
        "staff_new": "🌐 حجز أونلاين جديد\n{booking}\n📞 {phone}",
        "staff_cancelled": "❌ ألغى الزبون حجزًا أونلاين\n{booking}\n📞 {phone}",
        "booking": "🎾 {club_name}\n{court}، {date} {start}–{end}\n💳 {price}",
    },
    "ru": {
        "linked": "✅ Напоминания о вашей брони будут приходить сюда.\n\n{booking}",
        "help": "Здравствуйте! Откройте ссылку на Telegram со страницы брони, чтобы получать напоминания.",
        "unknown": "Извините, эта ссылка на бронь больше не действует.",
        "reminder": "⏰ Напоминание: ваша игра в падел скоро начнётся.\n\n{booking}",
        "staff_new": "🌐 Новая онлайн-бронь\n{booking}\n📞 {phone}",
        "staff_cancelled": "❌ Клиент отменил онлайн-бронь\n{booking}\n📞 {phone}",
        "booking": "🎾 {club_name}\n{court}, {date} {start}–{end}\n💳 {price}",
    },
}


def enabled():
    return bool(settings.TELEGRAM_BOT_TOKEN)


def start_link(booking):
    """The t.me link that connects a customer's chat to their booking, or None."""
    if not (enabled() and settings.TELEGRAM_BOT_USERNAME and booking.public_token):
        return None
    return f"https://t.me/{settings.TELEGRAM_BOT_USERNAME}?start={booking.public_token.hex}"


def call(method, payload, timeout=10):
    """One Bot API call. Returns the decoded result, or None on any failure."""
    if not enabled():
        return None
    request = urllib.request.Request(
        API.format(token=settings.TELEGRAM_BOT_TOKEN, method=method),
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read())
        return body.get("result") if body.get("ok") else None
    except Exception:  # network, Telegram outage, bad chat id: never break the app
        log.warning("Telegram %s failed", method, exc_info=True)
        return None


def send(chat_id, text):
    if not chat_id:
        return None
    return call("sendMessage", {"chat_id": chat_id, "text": text, "disable_web_page_preview": True})


def send_later(chat_id, text):
    """Send after the current transaction commits, without making the request wait."""
    if not (enabled() and chat_id):
        return
    transaction.on_commit(lambda: threading.Thread(target=send, args=(chat_id, text), daemon=True).start())


def text(club, key, **values):
    language = club.language if club.language in TEXTS else "en"
    return TEXTS[language][key].format(**values)


def describe(booking):
    club = booking.court.club
    tz = ZoneInfo(club.timezone)
    start, end = booking.start_at.astimezone(tz), booking.end_at.astimezone(tz)
    return text(
        club,
        "booking",
        club_name=club.name,
        court=booking.court.name,
        date=start.strftime("%d.%m.%Y"),
        start=start.strftime("%H:%M"),
        end=end.strftime("%H:%M"),
        price=f"{booking.price:.0f} {club.currency}",
    )


def notify_staff(booking, key):
    club = booking.court.club
    send_later(club.telegram_chat_id, text(club, key, booking=describe(booking), phone=booking.customer_phone or "—"))
