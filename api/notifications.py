"""In-app notifications for a club's staff, such as a new online booking.

The admin site asks every few seconds. Each staff member has their own unread
count: whatever came after they last opened the list.
"""

from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from clubs.models import Membership
from notify.models import Notification
from payments.services import release_expired_holds

LATEST = 30


def _membership(request, club):
    if not str(club or "").isdigit():
        raise ValidationError({"club": "Must be a club id."})
    return get_object_or_404(Membership, user=request.user, club_id=int(club))


class NotificationSerializer(serializers.ModelSerializer):
    unread = serializers.SerializerMethodField()

    class Meta:
        model = Notification
        fields = ("id", "kind", "booking", "data", "created_at", "unread")

    def get_unread(self, notification) -> bool:
        seen = self.context["seen"]
        return seen is None or notification.created_at > seen


class NotificationListView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        parameters=[OpenApiParameter("club", int, required=True)],
        responses=inline_serializer(
            "Notifications", {"unread": serializers.IntegerField(), "items": NotificationSerializer(many=True)}
        ),
    )
    def get(self, request):
        membership = _membership(request, request.query_params.get("club"))
        # The admin site asks often, so this is also where unpaid online holds run out.
        release_expired_holds()
        notifications = Notification.objects.filter(club_id=membership.club_id)
        seen = membership.notifications_seen_at
        unread = notifications.filter(created_at__gt=seen).count() if seen else notifications.count()
        items = NotificationSerializer(notifications[:LATEST], many=True, context={"seen": seen}).data
        return Response({"unread": unread, "items": items})


class NotificationSeenView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        request=inline_serializer("NotificationsSeen", {"club": serializers.IntegerField()}),
        responses=inline_serializer("NotificationsUnread", {"unread": serializers.IntegerField()}),
    )
    def post(self, request):
        membership = _membership(request, request.data.get("club"))
        membership.notifications_seen_at = timezone.now()
        membership.save(update_fields=["notifications_seen_at"])
        return Response({"unread": 0})
