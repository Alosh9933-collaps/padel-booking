// Thin client for the Django REST API. Tokens live in localStorage; an expired
// access token is refreshed once, transparently, before giving up.

export type Role = "owner" | "manager" | "receptionist";

export interface Club {
  id: number;
  name: string;
  timezone: string;
  currency: string;
  opening_hour: number;
  closing_hour: number;
  slot_minutes: number;
  role: Role;
}

export interface Court {
  id: number;
  club: number;
  club_name: string;
  name: string;
  kind: "indoor" | "outdoor";
  is_active: boolean;
}

export interface Slot {
  start: string;
  end: string;
  available: boolean;
  price: string | null;
}

export interface Availability {
  court: number;
  date: string;
  timezone: string;
  slots: Slot[];
}

export type PaymentStatus = "unpaid" | "partial" | "paid" | "open";
export type PaymentMethod = "cash" | "card" | "transfer";

export interface Booking {
  id: number;
  court: number;
  court_name: string;
  start_at: string;
  end_at: string;
  customer: number | null;
  customer_name: string;
  customer_phone: string;
  price: string;
  status: "confirmed" | "cancelled" | "no_show";
  /** Open play still running: end_at is only a hold until closing time. */
  is_open: boolean;
  /** Bookings of one weekly series share this id. */
  series: string | null;
  created_at: string;
  cancelled_at: string | null;
  court_total: string;
  items_total: string;
  total: string;
  paid_total: string;
  balance: string;
  payment_status: PaymentStatus;
}

export interface BillItem {
  id: number;
  product: number | null;
  name: string;
  unit_price: string;
  quantity: number;
  total: string;
  created_at: string;
}

export interface Payment {
  id: number;
  amount: string;
  method: PaymentMethod;
  payer_name: string;
  created_at: string;
  created_by_name: string;
}

export interface BookingBill extends Booking {
  items: BillItem[];
  payments: Payment[];
}

export interface PriceRule {
  id: number;
  club: number;
  court: number | null;
  days_of_week: number[];
  start_hour: number;
  end_hour: number;
  price_per_hour: string;
  priority: number;
}

export interface RevenueReport {
  club: number;
  currency: string;
  timezone: string;
  date_from: string;
  date_to: string;
  total: string;
  buffet_total: string;
  grand_total: string;
  bookings: number;
  by_court: { court: number; court_name: string; total: string; bookings: number }[];
  by_day: { date: string; total: string; buffet: string; bookings: number }[];
}

export interface DailyReport {
  club: number;
  date: string;
  currency: string;
  received: string;
  by_method: { method: PaymentMethod; total: string; count: number }[];
  buffet: { name: string; quantity: number; total: string }[];
  buffet_total: string;
  bookings: number;
  unpaid: Booking[];
  unpaid_total: string;
}

export interface Product {
  id: number;
  club: number;
  name: string;
  category: string;
  price: string;
  is_active: boolean;
}

export interface Customer {
  id: number;
  club: number;
  name: string;
  phone: string;
  notes: string;
  created_at: string;
  visits: number;
  no_shows: number;
  spent: string;
  last_visit: string | null;
}

export interface StaffMember {
  id: number;
  club: number;
  user: number;
  username: string;
  full_name: string;
  role: Role;
  last_login: string | null;
}

export interface WeeklyWeek {
  start_at: string;
  end_at: string;
  price: string | null;
  ok: boolean;
  code: string | null;
  detail: string | null;
}

export interface WeeklyResult {
  created: Booking[];
  skipped: WeeklyWeek[];
}

type Paged<T> = T[] | { results: T[] };

const ACCESS_KEY = "padel.access";
const REFRESH_KEY = "padel.refresh";
const USER_KEY = "padel.username";
export const SESSION_EXPIRED = "padel:session-expired";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked (private mode); the session then lasts one page load.
  }
}

export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(status: number, message: string, data: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export function errorMessage(data: unknown, status: number): string {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record.detail === "string") return record.detail;
    const parts = Object.entries(record).map(([field, value]) => {
      const text = Array.isArray(value) ? value.join(" ") : String(value);
      return field === "non_field_errors" ? text : `${field.replace(/_/g, " ")}: ${text}`;
    });
    if (parts.length) return parts.join(" · ");
  }
  return status >= 500 ? "The server had a problem. Please try again." : `Request failed (${status}).`;
}

export function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return "Cannot reach the server. Is Django running?";
  return error instanceof Error ? error.message : "Something went wrong.";
}

type Query = Record<string, string | number | null | undefined>;

interface Options {
  method?: string;
  body?: unknown;
  query?: Query;
}

function send(path: string, options: Options) {
  const url = new URL(`/api${path}`, window.location.origin);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const access = read(ACCESS_KEY);
  if (access) headers.Authorization = `Bearer ${access}`;
  return fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

let refreshing: Promise<boolean> | null = null;

function refreshAccess(): Promise<boolean> {
  // Parallel requests that all hit 401 share one refresh call.
  refreshing ??= (async () => {
    const refresh = read(REFRESH_KEY);
    if (!refresh) return false;
    const res = await fetch("/api/auth/token/refresh/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    write(ACCESS_KEY, data.access);
    if (data.refresh) write(REFRESH_KEY, data.refresh);
    return true;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function api<T>(path: string, options: Options = {}): Promise<T> {
  let res = await send(path, options);
  if (res.status === 401 && read(REFRESH_KEY) && (await refreshAccess())) {
    res = await send(path, options);
  }
  if (res.status === 401) {
    logout();
    window.dispatchEvent(new Event(SESSION_EXPIRED));
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, errorMessage(data, res.status), data);
  return data as T;
}

function asList<T>(data: Paged<T>): T[] {
  return Array.isArray(data) ? data : data.results;
}

export async function login(username: string, password: string) {
  const res = await fetch("/api/auth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = res.status === 401 ? "Wrong username or password." : errorMessage(data, res.status);
    throw new ApiError(res.status, message, data);
  }
  write(ACCESS_KEY, data.access);
  write(REFRESH_KEY, data.refresh);
  write(USER_KEY, username);
}

export function logout() {
  write(ACCESS_KEY, null);
  write(REFRESH_KEY, null);
}

export function isLoggedIn() {
  return Boolean(read(REFRESH_KEY) || read(ACCESS_KEY));
}

export function currentUsername() {
  return read(USER_KEY) ?? "";
}

export function rememberedClubId(): number | null {
  const raw = read("padel.club");
  return raw ? Number(raw) : null;
}

export function rememberClubId(id: number) {
  write("padel.club", String(id));
}

export type CourtInput = Pick<Court, "name" | "kind" | "is_active"> & { club: number };
export type PriceRuleInput = Omit<PriceRule, "id">;
export type ProductInput = Omit<Product, "id">;
export type CustomerInput = Pick<Customer, "club" | "name" | "phone" | "notes">;
export type BookingInput = {
  court: number;
  start_at: string;
  end_at: string;
  customer_name: string;
  customer_phone: string;
};

export const Api = {
  clubs: () => api<Paged<Club>>("/clubs/").then((d) => asList(d)),
  updateClub: (id: number, patch: Partial<Club>) =>
    api<Club>(`/clubs/${id}/`, { method: "PATCH", body: patch }),

  courts: () => api<Paged<Court>>("/courts/").then((d) => asList(d)),
  createCourt: (body: CourtInput) => api<Court>("/courts/", { method: "POST", body }),
  updateCourt: (id: number, patch: Partial<CourtInput>) =>
    api<Court>(`/courts/${id}/`, { method: "PATCH", body: patch }),
  availability: (courtId: number, date: string) =>
    api<Availability>(`/courts/${courtId}/availability/`, { query: { date } }),
  quote: (courtId: number, start: string, end: string) =>
    api<{ price: string }>(`/courts/${courtId}/quote/`, { query: { start, end } }),

  bookings: (query: Query) => api<Paged<Booking>>("/bookings/", { query }).then((d) => asList(d)),
  booking: (id: number) => api<BookingBill>(`/bookings/${id}/`),
  createBooking: (body: BookingInput) => api<BookingBill>("/bookings/", { method: "POST", body }),
  changeBooking: (id: number, patch: Partial<Omit<BookingInput, "court">>) =>
    api<BookingBill>(`/bookings/${id}/`, { method: "PATCH", body: patch }),
  cancelBooking: (id: number) => api<BookingBill>(`/bookings/${id}/cancel/`, { method: "POST" }),
  cancelFollowing: (id: number) =>
    api<Booking[]>(`/bookings/${id}/cancel-following/`, { method: "POST" }),
  noShow: (id: number) => api<BookingBill>(`/bookings/${id}/no-show/`, { method: "POST" }),
  startOpenPlay: (body: Omit<BookingInput, "start_at" | "end_at">) =>
    api<BookingBill>("/bookings/open/", { method: "POST", body }),
  stopOpenPlay: (id: number) => api<BookingBill>(`/bookings/${id}/stop/`, { method: "POST" }),
  weekly: (body: BookingInput & { weeks: number; dry_run: boolean }) =>
    api<WeeklyResult>("/bookings/weekly/", { method: "POST", body }),

  addItem: (bookingId: number, product: number, quantity = 1) =>
    api<BookingBill>(`/bookings/${bookingId}/items/`, { method: "POST", body: { product, quantity } }),
  setItemQuantity: (bookingId: number, itemId: number, quantity: number) =>
    api<BookingBill>(`/bookings/${bookingId}/items/${itemId}/`, { method: "PATCH", body: { quantity } }),
  addPayment: (bookingId: number, body: { amount: string; method: PaymentMethod; payer_name: string }) =>
    api<BookingBill>(`/bookings/${bookingId}/payments/`, { method: "POST", body }),
  removePayment: (bookingId: number, paymentId: number) =>
    api<BookingBill>(`/bookings/${bookingId}/payments/${paymentId}/`, { method: "DELETE" }),

  priceRules: (club: number) =>
    api<Paged<PriceRule>>("/price-rules/", { query: { club } }).then((d) => asList(d)),
  createPriceRule: (body: PriceRuleInput) => api<PriceRule>("/price-rules/", { method: "POST", body }),
  updatePriceRule: (id: number, body: PriceRuleInput) =>
    api<PriceRule>(`/price-rules/${id}/`, { method: "PUT", body }),
  deletePriceRule: (id: number) => api<void>(`/price-rules/${id}/`, { method: "DELETE" }),

  products: (club: number) => api<Paged<Product>>("/products/", { query: { club } }).then((d) => asList(d)),
  createProduct: (body: ProductInput) => api<Product>("/products/", { method: "POST", body }),
  updateProduct: (id: number, patch: Partial<ProductInput>) =>
    api<Product>(`/products/${id}/`, { method: "PATCH", body: patch }),
  deleteProduct: (id: number) => api<void>(`/products/${id}/`, { method: "DELETE" }),

  customers: (club: number, search = "") =>
    api<Paged<Customer>>("/customers/", { query: { club, search } }).then((d) => asList(d)),
  createCustomer: (body: CustomerInput) => api<Customer>("/customers/", { method: "POST", body }),
  updateCustomer: (id: number, patch: Partial<CustomerInput>) =>
    api<Customer>(`/customers/${id}/`, { method: "PATCH", body: patch }),

  staff: (club: number) => api<Paged<StaffMember>>("/staff/", { query: { club } }).then((d) => asList(d)),
  addStaff: (body: { club: number; username: string; password: string; first_name: string; role: Role }) =>
    api<StaffMember>("/staff/", { method: "POST", body }),
  changeStaffRole: (id: number, role: Role) =>
    api<StaffMember>(`/staff/${id}/`, { method: "PATCH", body: { role } }),
  removeStaff: (id: number) => api<void>(`/staff/${id}/`, { method: "DELETE" }),

  revenue: (club: number, from: string, to: string) =>
    api<RevenueReport>("/reports/revenue/", { query: { club, from, to } }),
  daily: (club: number, date: string) => api<DailyReport>("/reports/daily/", { query: { club, date } }),
};
