from io import StringIO

from django.core.management import call_command
from django.urls import reverse
from rest_framework.test import APITestCase

from bookings.models import Booking
from clubs.management.commands.seed_demo import DEMO_CLUB_NAME, DEMO_PASSWORD
from clubs.models import Club, Membership


class SeedDemoTests(APITestCase):
    def seed(self):
        call_command("seed_demo", stdout=StringIO())

    def test_seed_creates_a_usable_demo_club(self):
        self.seed()
        club = Club.objects.get(name=DEMO_CLUB_NAME)
        self.assertEqual(club.courts.count(), 3)
        self.assertEqual(Membership.objects.filter(club=club).count(), 3)
        self.assertEqual(Booking.objects.count(), 3)

        login = self.client.post(
            reverse("token_obtain_pair"),
            {"username": "demo_manager", "password": DEMO_PASSWORD},
            format="json",
        )
        self.assertEqual(login.status_code, 200)

    def test_running_the_seed_twice_does_not_duplicate_anything(self):
        self.seed()
        self.seed()
        self.assertEqual(Club.objects.filter(name=DEMO_CLUB_NAME).count(), 1)
        self.assertEqual(Booking.objects.count(), 3)
