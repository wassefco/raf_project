# API Design — منصة رف
# RESTful API — Node.js + Express
# Base URL: https://api.ruph.com/v1
# Authentication: Bearer JWT Token

# ============================================================
# AUTHENTICATION — المصادقة
# ============================================================

POST   /auth/send-otp          # إرسال OTP (واتساب/SMS/بريد)
POST   /auth/verify-otp        # التحقق من OTP والحصول على Token
POST   /auth/google             # تسجيل الدخول بـ Google
POST   /auth/apple              # تسجيل الدخول بـ Apple
POST   /auth/refresh            # تجديد الـ Token
POST   /auth/logout             # تسجيل الخروج

# ============================================================
# USERS — المستخدمون
# ============================================================

GET    /users/me                 # بيانات المستخدم الحالي
PATCH  /users/me                 # تعديل البيانات الشخصية
DELETE /users/me                 # حذف الحساب

# عناوين العميل
GET    /users/me/addresses        # قائمة العناوين
POST   /users/me/addresses        # إضافة عنوان
PATCH  /users/me/addresses/:id    # تعديل عنوان
DELETE /users/me/addresses/:id    # حذف عنوان
PATCH  /users/me/addresses/:id/default  # تعيين افتراضي

# إعدادات الإشعارات
GET    /users/me/notification-settings
PATCH  /users/me/notification-settings

# ============================================================
# STORES — المتاجر (عام)
# ============================================================

GET    /stores                   # قائمة المتاجر (بحث + فلاتر)
GET    /stores/:id               # تفاصيل متجر
GET    /stores/:id/products      # منتجات المتجر (بحث + فلاتر)
GET    /stores/:id/reviews       # تقييمات المتجر

# ============================================================
# PRODUCTS — المنتجات (عام)
# ============================================================

GET    /products                 # قائمة المنتجات (بحث + فلاتر + ترند)
GET    /products/:id             # تفاصيل منتج
GET    /products/:id/similar     # منتجات مشابهة

# ============================================================
# CATEGORIES — الفئات
# ============================================================

GET    /categories               # قائمة الفئات
GET    /categories/:id/products  # منتجات فئة معينة

# ============================================================
# ORDERS — الطلبات (العميل)
# ============================================================

POST   /orders                   # إنشاء طلب جديد
GET    /orders                   # طلبات العميل
GET    /orders/:id               # تفاصيل طلب
GET    /orders/:id/invoice       # تحميل الفاتورة (PDF)
POST   /orders/:id/review        # تقييم الطلب بعد التوصيل

# ============================================================
# COUPONS — الكوبونات (العميل)
# ============================================================

POST   /coupons/validate         # التحقق من صلاحية كوبون
                                 # Body: { code, store_id, subtotal }

# ============================================================
# WISHLIST — المفضلة
# ============================================================

GET    /wishlist                 # قائمة المفضلة
POST   /wishlist                 # إضافة لمفضلة { product_id? | store_id? }
DELETE /wishlist/:id             # حذف من المفضلة

# ============================================================
# NOTIFICATIONS — الإشعارات
# ============================================================

GET    /notifications            # قائمة الإشعارات
PATCH  /notifications/read-all   # تعليم الكل كمقروء
PATCH  /notifications/:id/read   # تعليم واحد كمقروء

# ============================================================
# REVIEWS — التقييمات (العميل)
# ============================================================

GET    /reviews/me               # تقييماتي

# ============================================================
# BANNERS — البنرات (عام)
# ============================================================

GET    /banners?placement=home_popup    # بنرات Popup
GET    /banners?placement=home_banner   # بنرات الرئيسية
GET    /banners?placement=stores_page   # بنرات صفحة المحلات
POST   /banners/:id/click               # تسجيل نقرة على بنر

# ============================================================
# ============================================================
# MERCHANT — لوحة التاجر
# Prefix: /merchant
# Auth: Bearer Token (role = merchant | employee)
# ============================================================

# --- المتجر ---
GET    /merchant/store                    # بيانات متجري
PATCH  /merchant/store                    # تعديل بيانات المتجر
PATCH  /merchant/store/status            # فتح/إغلاق المتجر { is_open }

# --- الموظفون ---
GET    /merchant/employees               # قائمة الموظفين
POST   /merchant/employees               # إضافة موظف
PATCH  /merchant/employees/:id           # تعديل صلاحيات موظف
DELETE /merchant/employees/:id           # حذف موظف

# --- المنتجات ---
GET    /merchant/products                # منتجاتي
POST   /merchant/products                # إضافة منتج (→ pending)
PATCH  /merchant/products/:id            # تعديل منتج
DELETE /merchant/products/:id            # حذف منتج
POST   /merchant/products/:id/media      # رفع صورة/فيديو (→ pending)
DELETE /merchant/products/:id/media/:mediaId  # حذف وسائط

# --- المخزون ---
GET    /merchant/inventory               # المخزون الكامل
PATCH  /merchant/inventory/:productId    # تحديث كمية { size, color, quantity }

# --- الطلبات ---
GET    /merchant/orders                  # طلبات متجري
GET    /merchant/orders/:id              # تفاصيل طلب
PATCH  /merchant/orders/:id/status      # تغيير حالة الطلب
GET    /merchant/orders/:id/invoice      # فاتورة الطلب

# --- الكوبونات ---
GET    /merchant/coupons                 # كوبوناتي
POST   /merchant/coupons                 # إنشاء كوبون
PATCH  /merchant/coupons/:id            # تعديل كوبون
DELETE /merchant/coupons/:id            # حذف كوبون
PATCH  /merchant/coupons/:id/toggle     # تفعيل/إيقاف { is_active }

# --- التقارير ---
GET    /merchant/reports/sales           # تقرير المبيعات ?period=daily|weekly|monthly
GET    /merchant/reports/products        # أفضل المنتجات
GET    /merchant/reports/coupons         # أداء الكوبونات
GET    /merchant/reports/visits          # زيارات الصفحة

# ============================================================
# ============================================================
# ADMIN — لوحة الإدارة
# Prefix: /admin
# Auth: Bearer Token (role = admin)
# ============================================================

# --- المتاجر ---
GET    /admin/stores                     # كل المتاجر + فلاتر
GET    /admin/stores/:id                 # تفاصيل متجر
POST   /admin/stores/:id/approve         # قبول متجر
POST   /admin/stores/:id/reject          # رفض متجر { reason }
PATCH  /admin/stores/:id                 # تعديل بيانات
PATCH  /admin/stores/:id/suspend        # إيقاف متجر
DELETE /admin/stores/:id                 # حذف نهائي
PATCH  /admin/stores/:id/commission      # تعديل نسبة العمولة
PATCH  /admin/stores/:id/upload-mode    # تحديد من يرفع الصور { upload_by_admin }

# --- موافقة الصور والمنتجات ---
GET    /admin/pending-media              # صور بانتظار الموافقة
POST   /admin/pending-media/:id/approve  # موافقة على صورة
POST   /admin/pending-media/:id/reject   # رفض صورة
GET    /admin/pending-products           # منتجات بانتظار الموافقة
POST   /admin/pending-products/:id/approve
POST   /admin/pending-products/:id/reject

# --- الطلبات ---
GET    /admin/orders                     # كل الطلبات
GET    /admin/orders/:id                 # تفاصيل طلب
PATCH  /admin/orders/:id/status         # تغيير الحالة يدوياً
POST   /admin/orders/:id/cancel          # إلغاء طلب { reason }
POST   /admin/orders/:id/assign          # تعيين سائق { driver_id }

# --- المالية والعمولات ---
GET    /admin/commissions                # كل العمولات
POST   /admin/commissions/:orderId/confirm  # تأكيد استلام عمولة
POST   /admin/invoices                   # إنشاء فاتورة لمتجر
GET    /admin/invoices                   # كل الفواتير
GET    /admin/invoices/:id               # تفاصيل فاتورة
PATCH  /admin/invoices/:id/paid         # تعليم كمدفوعة

# --- المحتوى والإعلانات ---
GET    /admin/banners                    # كل البنرات
POST   /admin/banners                    # إضافة بنر
PATCH  /admin/banners/:id               # تعديل بنر
DELETE /admin/banners/:id               # حذف بنر
PATCH  /admin/banners/:id/toggle        # تفعيل/إيقاف
PATCH  /admin/stores/:id/sort-order     # ترتيب متجر يدوياً { sort_order }
PATCH  /admin/products/:id/sort-order   # ترتيب منتج يدوياً { sort_order }

# --- الكوبونات العامة ---
GET    /admin/coupons                    # كل الكوبونات
POST   /admin/coupons                    # إنشاء كوبون عام
PATCH  /admin/coupons/:id               # تعديل
DELETE /admin/coupons/:id               # حذف

# --- المستخدمون ---
GET    /admin/users                      # كل المستخدمين
GET    /admin/users/:id                  # تفاصيل مستخدم
PATCH  /admin/users/:id/suspend         # تعليق حساب
PATCH  /admin/users/:id/ban             # حظر حساب
DELETE /admin/users/:id                  # حذف حساب

# --- المشرفون ---
GET    /admin/admins                     # قائمة المشرفين
POST   /admin/admins                     # إضافة مشرف
PATCH  /admin/admins/:id/permissions    # تعديل صلاحيات
DELETE /admin/admins/:id                 # حذف مشرف

# --- التقارير ---
GET    /admin/reports/overview           # نظرة شاملة
GET    /admin/reports/sales              # تقرير المبيعات ?period=
GET    /admin/reports/stores             # أفضل المتاجر
GET    /admin/reports/products           # أكثر المنتجات مبيعاً
GET    /admin/reports/commissions        # تقرير العمولات
GET    /admin/reports/banners            # إحصاءات البنرات
GET    /admin/reports/users              # نشاط المستخدمين

# ============================================================
# ============================================================
# DELIVERY — لوحة التوصيل
# Prefix: /delivery
# Auth: Bearer Token (role = supervisor | driver)
# ============================================================

# --- مشرف التوصيل ---
GET    /delivery/orders                  # كل الطلبات
GET    /delivery/orders/:id              # تفاصيل طلب
POST   /delivery/orders/:id/assign       # تعيين سائق { driver_id }
POST   /delivery/orders/:id/reassign    # إعادة التعيين { driver_id }
PATCH  /delivery/orders/:id/status      # تغيير حالة يدوياً

GET    /delivery/drivers                 # قائمة السائقين
GET    /delivery/drivers/:id             # ملف سائق
POST   /delivery/drivers                 # إضافة سائق
PATCH  /delivery/drivers/:id            # تعديل بيانات
DELETE /delivery/drivers/:id             # حذف سائق
PATCH  /delivery/drivers/:id/toggle     # تفعيل/إيقاف { is_active }

GET    /delivery/reports                 # تقارير التوصيل

# --- السائق ---
GET    /delivery/driver/available        # الطلبات المتاحة للاستلام
POST   /delivery/driver/accept/:orderId  # استلام طلب (Transaction — حماية تضارب)
GET    /delivery/driver/active           # طلبي الحالي
PATCH  /delivery/driver/orders/:id/status  # تحديث الحالة { status: in_delivery|delivered|returned }
GET    /delivery/driver/history          # سجل توصيلاتي
GET    /delivery/driver/stats            # إحصاءاتي

# ============================================================
# RESPONSE FORMAT — شكل الاستجابة الموحد
# ============================================================

# نجاح:
# {
#   "success": true,
#   "data": { ... },
#   "meta": { "page": 1, "limit": 20, "total": 150 }  ← للقوائم فقط
# }

# خطأ:
# {
#   "success": false,
#   "error": {
#     "code": "STORE_NOT_FOUND",
#     "message": "المتجر غير موجود"
#   }
# }

# ============================================================
# ERROR CODES — رموز الأخطاء
# ============================================================

# AUTH_INVALID_OTP        — رمز OTP خاطئ
# AUTH_OTP_EXPIRED        — OTP منتهي الصلاحية
# AUTH_UNAUTHORIZED       — غير مصرح
# AUTH_FORBIDDEN          — ليس لديك صلاحية

# STORE_NOT_FOUND         — المتجر غير موجود
# STORE_SUSPENDED         — المتجر موقوف
# STORE_CLOSED            — المتجر مغلق حالياً
# PRODUCT_NOT_FOUND       — المنتج غير موجود
# PRODUCT_OUT_OF_STOCK    — نفد المخزون
# PRODUCT_LIMIT_REACHED   — وصلت للحد الأقصى حسب الباقة

# ORDER_NOT_FOUND         — الطلب غير موجود
# ORDER_ALREADY_ASSIGNED  — الطلب محجوز من سائق آخر (حماية التضارب)
# ORDER_CANNOT_CANCEL     — لا يمكن الإلغاء في هذه الحالة

# COUPON_NOT_FOUND        — الكوبون غير موجود
# COUPON_EXPIRED          — الكوبون منتهي
# COUPON_USED_UP          — الكوبون استُنفد
# COUPON_NOT_ELIGIBLE     — غير مؤهل لاستخدام هذا الكوبون

# VALIDATION_ERROR        — خطأ في البيانات المدخلة

# ============================================================
# QUERY PARAMS — معاملات البحث الشائعة
# ============================================================

# GET /stores
# ?category=clothing&package=premium&is_open=true
# &search=casa&sort=rating|sales|newest&page=1&limit=20

# GET /products
# ?store_id=...&category_id=...&search=قميص
# &min_price=5&max_price=50&sort=trending|sales|newest|price_asc|price_desc
# &page=1&limit=20

# GET /admin/orders
# ?status=pending&store_id=...&driver_id=...
# &from=2026-01-01&to=2026-05-31&page=1&limit=20
