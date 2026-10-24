from django.urls import include, path
from rest_framework.routers import DefaultRouter
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from .dashboard import DashboardView
from .notifications import NotificationListView, NotificationSeenView
from .public import (
    DemoPaymentView,
    PublicAvailabilityView,
    PublicBookingCancelView,
    PublicBookingCreateView,
    PublicBookingView,
    PublicClubView,
    YooKassaWebhookView,
)
from .operations import (
    ActivityViewSet,
    CustomerCategoryViewSet,
    CustomerViewSet,
    DailyReportView,
    ProductViewSet,
    SaleViewSet,
    ShiftViewSet,
    StaffViewSet,
    TopUpPlanViewSet,
)
from .views import (
    BookingViewSet,
    ClubViewSet,
    CourtViewSet,
    PriceRuleViewSet,
    RevenueReportView,
)

router = DefaultRouter()
router.register("clubs", ClubViewSet, basename="club")
router.register("courts", CourtViewSet, basename="court")
router.register("price-rules", PriceRuleViewSet, basename="pricerule")
router.register("bookings", BookingViewSet, basename="booking")
router.register("products", ProductViewSet, basename="product")
router.register("customers", CustomerViewSet, basename="customer")
router.register("customer-categories", CustomerCategoryViewSet, basename="customercategory")
router.register("staff", StaffViewSet, basename="staff")
router.register("sales", SaleViewSet, basename="sale")
router.register("shifts", ShiftViewSet, basename="shift")
router.register("activity", ActivityViewSet, basename="activity")
router.register("topup-plans", TopUpPlanViewSet, basename="topupplan")

urlpatterns = [
    path("auth/token/", TokenObtainPairView.as_view(), name="token_obtain_pair"),
    path("auth/token/refresh/", TokenRefreshView.as_view(), name="token_refresh"),
    path("reports/revenue/", RevenueReportView.as_view(), name="revenue-report"),
    path("reports/daily/", DailyReportView.as_view(), name="daily-report"),
    path("reports/dashboard/", DashboardView.as_view(), name="dashboard"),
    path("public/clubs/<slug:slug>/", PublicClubView.as_view(), name="public-club"),
    path("public/clubs/<slug:slug>/availability/", PublicAvailabilityView.as_view(), name="public-availability"),
    path("public/clubs/<slug:slug>/bookings/", PublicBookingCreateView.as_view(), name="public-booking-create"),
    path("public/bookings/<str:token>/", PublicBookingView.as_view(), name="public-booking"),
    path("public/bookings/<str:token>/cancel/", PublicBookingCancelView.as_view(), name="public-booking-cancel"),
    path("public/payments/yookassa/", YooKassaWebhookView.as_view(), name="yookassa-webhook"),
    path("public/payments/<str:payment_id>/demo/", DemoPaymentView.as_view(), name="demo-payment"),
    path("notifications/", NotificationListView.as_view(), name="notifications"),
    path("notifications/seen/", NotificationSeenView.as_view(), name="notifications-seen"),
    path("", include(router.urls)),
]
