from .models import Club, Membership

MANAGER_ROLES = (Membership.Role.OWNER, Membership.Role.MANAGER)


def clubs_of(user):
    """Clubs the given user works at. Every API query is scoped through this."""
    return Club.objects.filter(memberships__user=user)


def managed_clubs_of(user):
    """Clubs where the user is an owner or a manager.

    Both conditions must sit in the same filter() call. Two chained filter()
    calls on a multi-valued relation may match two different membership rows,
    so a receptionist would pass whenever someone else in the club is an owner.
    """
    return Club.objects.filter(memberships__user=user, memberships__role__in=MANAGER_ROLES)


def can_manage(user, club):
    return managed_clubs_of(user).filter(pk=club.pk).exists()
