from django.urls import include, path
from rest_framework.routers import DefaultRouter
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

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

urlpatterns = [
    path("auth/token/", TokenObtainPairView.as_view(), name="token_obtain_pair"),
    path("auth/token/refresh/", TokenRefreshView.as_view(), name="token_refresh"),
    path("reports/revenue/", RevenueReportView.as_view(), name="revenue-report"),
    path("", include(router.urls)),
]
