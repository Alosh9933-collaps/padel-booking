"""Payment providers for online prepayments.

YooKassa is used when YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY are set. Without
them, and only when PAYMENTS_DEMO is on (the default while DEBUG), a demo
provider stands in: its payment page is part of this app and moves no money.
With neither, online bookings that need a prepayment are refused.
"""

import base64
import json
import logging
import urllib.error
import urllib.request

from django.conf import settings

from bookings.services import BookingError

log = logging.getLogger(__name__)

PENDING, SUCCEEDED, CANCELED = "pending", "succeeded", "canceled"


class PaymentError(BookingError):
    code = "payment_failed"


class DemoProvider:
    """For trying the flow: the demo page (/pay/demo/<id>) decides how the payment ends."""

    name = "demo"

    def create(self, payment, *, description, return_url):
        return str(payment.id), f"/pay/demo/{payment.id}"

    def status(self, payment):
        return payment.status

    def refund(self, payment, amount):
        pass


class YooKassaProvider:
    """https://yookassa.ru/developers/api: one payment per prepayment, captured right away."""

    name = "yookassa"
    API = "https://api.yookassa.ru/v3"

    def _call(self, method, path, body=None, idempotence_key=None):
        secret = f"{settings.YOOKASSA_SHOP_ID}:{settings.YOOKASSA_SECRET_KEY}".encode()
        headers = {"Authorization": f"Basic {base64.b64encode(secret).decode()}", "Content-Type": "application/json"}
        if idempotence_key:
            headers["Idempotence-Key"] = idempotence_key
        request = urllib.request.Request(
            f"{self.API}{path}",
            data=None if body is None else json.dumps(body).encode(),
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return json.loads(response.read())
        except (urllib.error.URLError, ValueError) as exc:
            log.warning("YooKassa %s %s failed", method, path, exc_info=True)
            raise PaymentError("The payment service did not answer. Please try again.") from exc

    def create(self, payment, *, description, return_url):
        currency = payment.booking.court.club.currency
        data = self._call(
            "POST",
            "/payments",
            {
                "amount": {"value": f"{payment.amount:.2f}", "currency": currency},
                "capture": True,
                "confirmation": {"type": "redirect", "return_url": return_url},
                "description": description[:128],
                "metadata": {"payment": str(payment.id)},
            },
            # Asking twice for the same payment never charges twice.
            idempotence_key=str(payment.id),
        )
        try:
            return data["id"], data["confirmation"]["confirmation_url"]
        except (KeyError, TypeError) as exc:
            raise PaymentError("The payment service sent an unexpected answer.") from exc

    def status(self, payment):
        state = self._call("GET", f"/payments/{payment.provider_id}").get("status")
        # With capture=True a payment goes straight from pending to succeeded or canceled.
        return {SUCCEEDED: SUCCEEDED, CANCELED: CANCELED}.get(state, PENDING)

    def refund(self, payment, amount):
        currency = payment.booking.court.club.currency
        self._call(
            "POST",
            "/refunds",
            {"payment_id": payment.provider_id, "amount": {"value": f"{amount:.2f}", "currency": currency}},
            idempotence_key=f"refund-{payment.id}",
        )


PROVIDERS = {provider.name: provider for provider in (DemoProvider(), YooKassaProvider())}


def active():
    """The provider new payments go to, or None when online payment is not set up."""
    if settings.YOOKASSA_SHOP_ID and settings.YOOKASSA_SECRET_KEY:
        return PROVIDERS["yookassa"]
    if settings.PAYMENTS_DEMO:
        return PROVIDERS["demo"]
    return None


def of(payment):
    return PROVIDERS[payment.provider]
