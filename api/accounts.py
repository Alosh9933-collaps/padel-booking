"""Signing in and passwords."""

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from drf_spectacular.utils import extend_schema
from rest_framework import serializers, status
from rest_framework.exceptions import APIException
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer
from rest_framework_simplejwt.views import TokenObtainPairView


class PasswordRejected(APIException):
    """A password problem as {"detail", "code"}, so the frontend can say it in the user's language."""

    status_code = status.HTTP_400_BAD_REQUEST

    def __init__(self, message, code):
        super().__init__({"detail": message, "code": code})


def check_new_password(password, user=None):
    """Django's password rules (length, too common, only digits, too close to the username)."""
    try:
        validate_password(password, user)
    except DjangoValidationError as exc:
        first = exc.error_list[0]
        raise PasswordRejected(first.messages[0], first.code or "bad_password") from exc


class LoginSerializer(TokenObtainPairSerializer):
    """Sign in with the username in any case: phone keyboards like to write "Demo_owner"."""

    def validate(self, attrs):
        name = attrs.get(self.username_field, "").strip()
        User = get_user_model()
        if not User.objects.filter(username=name).exists():
            # Only when exactly one account matches, so "Ali" and "ali" can never be confused.
            matches = list(User.objects.filter(username__iexact=name).values_list("username", flat=True)[:2])
            if len(matches) == 1:
                name = matches[0]
        attrs[self.username_field] = name
        return super().validate(attrs)


class LoginView(TokenObtainPairView):
    serializer_class = LoginSerializer


class NewPasswordSerializer(serializers.Serializer):
    password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)


class PasswordChangeSerializer(serializers.Serializer):
    current_password = serializers.CharField(write_only=True, trim_whitespace=False)
    new_password = serializers.CharField(write_only=True, trim_whitespace=False, max_length=128)


class ChangePasswordView(APIView):
    """Change your own password; the current one is asked first."""

    permission_classes = [IsAuthenticated]

    @extend_schema(request=PasswordChangeSerializer, responses={204: None})
    def post(self, request):
        serializer = PasswordChangeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = request.user
        if not user.check_password(serializer.validated_data["current_password"]):
            raise PasswordRejected("Your current password is not right.", "wrong_password")
        new_password = serializer.validated_data["new_password"]
        check_new_password(new_password, user)
        user.set_password(new_password)
        user.save(update_fields=["password"])
        return Response(status=status.HTTP_204_NO_CONTENT)
