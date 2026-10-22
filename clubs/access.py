from .models import Club


def clubs_of(user):
    """Clubs the given user works at. Every API query is scoped through this."""
    return Club.objects.filter(memberships__user=user)