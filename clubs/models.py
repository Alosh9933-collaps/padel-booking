

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
 
from django.conf import settings
from django.contrib.postgres.fields import ArrayField
from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.db.models import F, Q
 
 
class Club(models.Model):
    """One club = one tenant. Every other table points back to a Club."""
 
    class SlotMinutes(models.IntegerChoices):
        THIRTY = 30, "30 minutes"
        SIXTY = 60, "60 minutes"
 
    name = models.CharField(max_length=120)
    timezone = models.CharField(max_length=64, default="Europe/Moscow")
    currency = models.CharField(max_length=3, default="RUB")
    # Opening hours as whole hours. closing_hour = 24 means "until midnight".
    opening_hour = models.PositiveSmallIntegerField(
        default=8, validators=[MaxValueValidator(23)]
    )
    closing_hour = models.PositiveSmallIntegerField(
        default=24, validators=[MaxValueValidator(24)], help_text="1-24, where 24 is midnight"
    )
    # Booking grid: 30 allows 60/90/120-minute games, 60 allows whole hours only.
    slot_minutes = models.PositiveSmallIntegerField(
        choices=SlotMinutes.choices, default=SlotMinutes.THIRTY
    )
    created_at = models.DateTimeField(auto_now_add=True)
 
    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=Q(opening_hour__lt=F("closing_hour")),
                name="club_opening_before_closing",
            ),
        ]
 
    def clean(self):
        try:
            ZoneInfo(self.timezone)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValidationError({"timezone": "Unknown timezone name."})
 
    def __str__(self):
        return self.name
 
 
class Membership(models.Model):
    """Which user works at which club, and with what role."""
 
    class Role(models.TextChoices):
        OWNER = "owner", "Owner"
        MANAGER = "manager", "Manager"
        RECEPTIONIST = "receptionist", "Receptionist"
 
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="memberships"
    )
    club = models.ForeignKey(Club, on_delete=models.CASCADE, related_name="memberships")
    role = models.CharField(max_length=20, choices=Role.choices, default=Role.RECEPTIONIST)
 
    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["user", "club"], name="uniq_membership_user_club"),
        ]
 
    def __str__(self):
        return f"{self.user} @ {self.club} ({self.role})"
 
 
class Court(models.Model):
    class Kind(models.TextChoices):
        INDOOR = "indoor", "Indoor"
        OUTDOOR = "outdoor", "Outdoor"
 
    club = models.ForeignKey(Club, on_delete=models.CASCADE, related_name="courts")
    name = models.CharField(max_length=60)
    kind = models.CharField(max_length=10, choices=Kind.choices, default=Kind.INDOOR)
    is_active = models.BooleanField(default=True)
 
    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["club", "name"], name="uniq_court_name_per_club"),
        ]
 
    def __str__(self):
        return f"{self.club} / {self.name}"
 
 
class PriceRule(models.Model):
    """Hourly price for a weekday + hour range.
 
    court = NULL  -> applies to every court of the club.
    When several rules match, the highest priority wins; on a tie a
    court-specific rule beats a club-wide one.
    """
 
    club = models.ForeignKey(Club, on_delete=models.CASCADE, related_name="price_rules")
    court = models.ForeignKey(
        Court, null=True, blank=True, on_delete=models.CASCADE, related_name="price_rules"
    )
    days_of_week = ArrayField(
        models.PositiveSmallIntegerField(validators=[MaxValueValidator(6)]),
        size=7,
        help_text="0=Monday ... 6=Sunday",
    )
    start_hour = models.PositiveSmallIntegerField(validators=[MaxValueValidator(23)])
    end_hour = models.PositiveSmallIntegerField(
        validators=[MaxValueValidator(24)], help_text="24 means midnight"
    )
    price_per_hour = models.DecimalField(max_digits=10, decimal_places=2)
    priority = models.SmallIntegerField(default=0)
 
    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=Q(start_hour__lt=F("end_hour")),
                name="pricerule_start_before_end",
            ),
        ]
 
    def clean(self):
        if self.court_id and self.court.club_id != self.club_id:
            raise ValidationError({"court": "This court belongs to a different club."})
 
    def __str__(self):
        return f"{self.club}: {self.start_hour}-{self.end_hour} @ {self.price_per_hour}"


def normalize_phone(raw):
    """Digits only, keeping a leading +, so "+7 (900) 000-00-00" matches "+79000000000"."""
    raw = (raw or "").strip()
    digits = "".join(ch for ch in raw if ch.isdigit())
    return f"+{digits}" if raw.startswith("+") and digits else digits


PERCENT = [MinValueValidator(0), MaxValueValidator(100)]


class CustomerCategory(models.Model):
    """A label the club gives its players (Regular, VIP, Coach...), optionally with a discount."""

    club = models.ForeignKey(Club, on_delete=models.CASCADE, related_name="customer_categories")
    name = models.CharField(max_length=40)
    color = models.CharField(max_length=7, default="#1d6fd1", help_text="Hex colour, e.g. #1d6fd1")
    # Suggested on court time for customers in this category; 0 means no discount.
    discount_percent = models.PositiveSmallIntegerField(default=0, validators=PERCENT)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["club", "name"], name="uniq_category_name_per_club"),
            models.CheckConstraint(condition=Q(discount_percent__lte=100), name="category_percent_max_100"),
        ]

    def __str__(self):
        return self.name


class DiscountSettings(models.Model):
    """The club's loyalty rules. Each rule is off until a manager turns it on.

    A rule never applies itself: when a booking qualifies, staff see the offer
    on the bill and apply it with one click.
    """

    club = models.OneToOneField(Club, on_delete=models.CASCADE, related_name="discount_settings")
    first_visit_enabled = models.BooleanField(default=False)
    first_visit_percent = models.PositiveSmallIntegerField(default=25, validators=PERCENT)
    nth_visit_enabled = models.BooleanField(default=False)
    nth_visit_every = models.PositiveSmallIntegerField(
        default=10, validators=[MinValueValidator(2), MaxValueValidator(100)]
    )
    nth_visit_percent = models.PositiveSmallIntegerField(default=100, validators=PERCENT)

    def __str__(self):
        return f"Discount rules of {self.club}"


class Customer(models.Model):
    """A player of one club, recognised by phone number."""

    club = models.ForeignKey(Club, on_delete=models.CASCADE, related_name="customers")
    name = models.CharField(max_length=120)
    phone = models.CharField(max_length=32, blank=True)
    category = models.ForeignKey(
        CustomerCategory, null=True, blank=True, on_delete=models.SET_NULL, related_name="customers"
    )
    notes = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["club", "phone"],
                condition=~Q(phone=""),
                name="uniq_customer_phone_per_club",
            ),
        ]
        indexes = [models.Index(fields=["club", "name"], name="customer_club_name_idx")]

    def save(self, *args, **kwargs):
        self.phone = normalize_phone(self.phone)
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.name} ({self.phone})" if self.phone else self.name

