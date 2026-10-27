from django.contrib.auth import get_user_model
from django.urls import reverse

from clubs.models import Membership

from .test_api import ApiTestBase


class LoginTests(ApiTestBase):
    def login(self, username, password="pass-12345"):
        self.client.force_authenticate(None)
        return self.client.post(reverse("token_obtain_pair"), {"username": username, "password": password}, format="json")

    def test_the_username_case_does_not_matter(self):
        # Phone keyboards capitalise the first letter.
        self.assertEqual(self.login("User_a ").status_code, 200)

    def test_two_accounts_that_differ_only_in_case_are_never_mixed_up(self):
        User = get_user_model()
        User.objects.create_user("Ali", password="pass-12345")
        User.objects.create_user("ali", password="pass-12345")
        self.assertEqual(self.login("ALI").status_code, 401)
        self.assertEqual(self.login("Ali").status_code, 200)


class OwnPasswordTests(ApiTestBase):
    def change(self, current, new):
        return self.client.post(
            reverse("change-password"), {"current_password": current, "new_password": new}, format="json"
        )

    def test_change_your_own_password(self):
        self.assertEqual(self.change("wrong", "a-new-strong-pass").data["code"], "wrong_password")
        self.assertEqual(self.change("pass-12345", "short").data["code"], "password_too_short")
        self.assertEqual(self.change("pass-12345", "a-new-strong-pass").status_code, 204)
        self.assertTrue(get_user_model().objects.get(username="user_a").check_password("a-new-strong-pass"))


class StaffPasswordTests(ApiTestBase):
    def setUp(self):
        super().setUp()
        self.me = Membership.objects.get(user=self.user_a, club=self.club_a)
        self.me.role = Membership.Role.OWNER
        self.me.save()
        self.desk = get_user_model().objects.create_user("desk", password="pass-12345")
        self.desk_job = Membership.objects.create(user=self.desk, club=self.club_a, role=Membership.Role.RECEPTIONIST)

    def reset(self, membership, password="a-new-strong-pass"):
        return self.client.post(reverse("staff-password", args=[membership.pk]), {"password": password}, format="json")

    def test_the_owner_gives_a_staff_member_a_new_password(self):
        self.assertEqual(self.reset(self.desk_job).status_code, 204)
        self.desk.refresh_from_db()
        self.assertTrue(self.desk.check_password("a-new-strong-pass"))

    def test_weak_passwords_are_refused(self):
        self.assertEqual(self.reset(self.desk_job, "12345678").data["code"], "password_too_common")
        self.assertEqual(self.reset(self.desk_job, "48201937655").data["code"], "password_entirely_numeric")

    def test_a_manager_cannot_reset_another_manager(self):
        self.me.role = Membership.Role.MANAGER
        self.me.save()
        self.desk_job.role = Membership.Role.MANAGER
        self.desk_job.save()
        self.assertEqual(self.reset(self.desk_job).status_code, 403)

    def test_not_someone_who_also_works_at_a_club_you_do_not_run(self):
        Membership.objects.create(user=self.desk, club=self.club_b, role=Membership.Role.OWNER)
        self.assertEqual(self.reset(self.desk_job).status_code, 403)
        self.desk.refresh_from_db()
        self.assertTrue(self.desk.check_password("pass-12345"))

    def test_your_own_password_needs_the_current_one(self):
        self.assertEqual(self.reset(self.me).status_code, 403)
