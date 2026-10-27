# Padel Booking API

![CI](https://github.com/Alosh9933-collaps/padel-booking-api/actions/workflows/ci.yml/badge.svg)

A multi-club court booking backend for padel clubs. A club manager sets up courts and
hourly prices, staff create and cancel bookings, and the **database itself refuses
double bookings**, even when requests arrive at the same moment.

> Status: backend API with Django Admin as the first interface. No frontend yet.

<!-- Add a screenshot of /api/docs/ (Swagger UI) here -->

## Features

- JWT authentication
- Multi-club (multi-tenant): every club only sees its own data
- Roles per club: owner, manager, receptionist
- Courts (indoor/outdoor), opening hours, and a booking grid of 30 or 60 minutes
- Flexible hourly pricing: rules per weekday and hour range, per club or per court,
  with priorities (for example cheaper mornings, pricier evenings and weekends)
- Availability per court and day, with a price for every slot
- Bookings with the price frozen at creation time; cancelling frees the slot
- Revenue report per club, per court and per day
- OpenAPI/Swagger documentation
- Automated tests and GitHub Actions CI

## Tech stack

Python, Django, Django REST Framework, PostgreSQL, Simple JWT, drf-spectacular, Docker Compose.

## Quick start

Requirements: Python 3.12+ and Docker.

```bash
git clone https://github.com/Alosh9933-collaps/padel-booking-api.git
cd padel-booking-api

python -m venv .venv
# Windows PowerShell:  .\.venv\Scripts\Activate.ps1
# Linux / macOS:       source .venv/bin/activate
pip install -r requirements.txt

docker compose up -d db
python manage.py migrate
python manage.py seed_demo
python manage.py runserver
```

Open http://127.0.0.1:8000/api/docs/ for the interactive API documentation.

`seed_demo` creates a demo club with 3 courts, price rules, 3 bookings and 3 accounts
(password for all: `demo-pass-123`):

| Username         | Role         | Can do                                    |
|------------------|--------------|-------------------------------------------|
| `demo_owner`     | owner        | everything in the club                    |
| `demo_manager`   | manager      | manage courts, prices, settings, reports  |
| `demo_reception` | receptionist | read data, create and cancel bookings     |

Try it in Swagger: `POST /api/auth/token/` with a demo login, copy the `access` token,
click **Authorize**, paste it, then call `GET /api/courts/` and
`GET /api/courts/{id}/availability/?date=YYYY-MM-DD`.

Never run `seed_demo` on a real deployment: it creates accounts with a public password.

To use Django Admin: `python manage.py createsuperuser`, then open `/admin/`.

### Configuration

The database settings can be overridden with environment variables
(`DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`). The defaults match `docker-compose.yml`.

## Tests

```bash
python manage.py test
```

This includes a concurrency test that sends several simultaneous booking requests for the
same slot and checks that exactly one succeeds.

## API overview

| Method | Path | Who |
|--------|------|-----|
| POST | `/api/auth/token/`, `/api/auth/token/refresh/` | anyone |
| GET, PATCH | `/api/clubs/`, `/api/clubs/{id}/` | members read, owner/manager edit |
| GET, POST, PATCH | `/api/courts/`, `/api/courts/{id}/` | members read, owner/manager write |
| GET | `/api/courts/{id}/availability/?date=` | members |
| GET, POST, PATCH, DELETE | `/api/price-rules/`, `/api/price-rules/{id}/` | members read, owner/manager write |
| GET, POST | `/api/bookings/`, `/api/bookings/{id}/` | members |
| POST | `/api/bookings/{id}/cancel/` | members |
| GET | `/api/reports/revenue/?club=&from=&to=` | owner/manager |

Booking errors: `409` when the slot is taken, `400` for any other broken rule
(outside opening hours, off the time grid, no price rule, inactive court).

## Design decisions

**Double bookings are prevented by the database, not by application code.**
`Booking` has a PostgreSQL exclusion constraint (`btree_gist`) that forbids two confirmed
bookings on the same court with overlapping time ranges. A check-then-insert in Python
would have a race condition; the constraint cannot be bypassed. Ranges are half-open, so
10:00-11:00 followed by 11:00-12:00 is allowed, and cancelled bookings do not block the slot.

**Multi-tenancy with a `Club` foreign key.** One database, every table points back to a club.
Access goes through `Membership` (user, club, role). Every queryset is scoped through
helpers in `clubs/access.py`, and other clubs' objects look like they do not exist (404).

**Business logic lives in a service layer** (`bookings/services.py`), so API views and the
admin share the same rules for validation, pricing and creating bookings.

**Prices come from rules and are frozen on the booking.** Changing prices later never
rewrites past bookings.

**Time handling.** Datetimes are stored in UTC. Opening hours and prices are evaluated in
each club's own timezone.

## Project structure

```
clubs/      Club, Membership, Court, PriceRule, access helpers, seed_demo command
bookings/   Booking model with the overlap constraint, services, availability
api/        serializers, views, URLs, API tests
config/     Django settings and root URLs
```

## Known limitations and roadmap

- No frontend yet (Django Admin and Swagger only)
- No online payments or notifications
- No API for inviting staff; memberships are created in Django Admin
- Django Admin is not scoped per club: only give admin access to trusted staff
- Settings are for development; production hardening (secrets, `DEBUG`, hosts, HTTPS) is still to do
- No recurring (weekly) bookings yet