from django.db import migrations
from django.utils.text import slugify


def fill_slugs(apps, schema_editor):
    """Give existing clubs the address of their public booking page."""
    Club = apps.get_model("clubs", "Club")
    taken = set(Club.objects.exclude(slug=None).values_list("slug", flat=True))
    for club in Club.objects.filter(slug=None).order_by("pk"):
        base = slugify(club.name)[:50] or "club"
        slug, n = base, 2
        while slug in taken:
            slug, n = f"{base}-{n}", n + 1
        taken.add(slug)
        club.slug = slug
        club.save(update_fields=["slug"])


class Migration(migrations.Migration):
    dependencies = [("clubs", "0004_club_language_club_online_booking_enabled_and_more")]

    operations = [migrations.RunPython(fill_slugs, migrations.RunPython.noop)]
