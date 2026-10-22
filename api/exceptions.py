from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import exception_handler

from bookings.services import BookingError, SlotUnavailable


def api_exception_handler(exc, context):
    """Turn expected booking problems into {"detail", "code"} responses.

    An overlap is 409 Conflict; every other booking rule is 400. The code lets
    the frontend show the message in the user's language.
    """
    if isinstance(exc, BookingError):
        code = status.HTTP_409_CONFLICT if isinstance(exc, SlotUnavailable) else status.HTTP_400_BAD_REQUEST
        return Response({"detail": str(exc), "code": exc.code}, status=code)
    return exception_handler(exc, context)
