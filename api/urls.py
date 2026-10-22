from django.urls import include, path
from rest_framework.routers import DefaultRouter
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from .operations import CustomerViewSet, DailyReportView, ProductViewSet, StaffViewSet
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
router.register("staff", StaffViewSet, basename="staff")

urlpatterns = [
    path("auth/token/", TokenObtainPairView.as_view(), name="token_obtain_pair"),
    path("auth/token/refresh/", TokenRefreshView.as_view(), name="token_refresh"),
    path("reports/revenue/", RevenueReportView.as_view(), name="revenue-report"),
    path("reports/daily/", DailyReportView.as_view(), name="daily-report"),
    path("", include(router.urls)),
]
