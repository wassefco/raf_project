-- ============================================================
-- قاعدة بيانات منصة رف — Ruph Marketplace
-- PostgreSQL Schema — الإصدار 1.0
-- ============================================================

-- ============================================================
-- 1. USERS — المستخدمون
-- ============================================================
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(100),
  phone         VARCHAR(20) UNIQUE,          -- واتساب / SMS
  email         VARCHAR(150) UNIQUE,
  role          VARCHAR(20) NOT NULL          -- customer | merchant | driver | supervisor | admin
                CHECK (role IN ('customer','merchant','driver','supervisor','admin')),
  status        VARCHAR(20) DEFAULT 'active'
                CHECK (status IN ('active','suspended','banned','deleted')),
  lang          VARCHAR(5)  DEFAULT 'ar'
                CHECK (lang IN ('ar','en')),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 2. ADMIN_PERMISSIONS — صلاحيات المشرفين
-- ============================================================
CREATE TABLE admin_permissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_stores      BOOLEAN DEFAULT FALSE,
  can_orders      BOOLEAN DEFAULT FALSE,
  can_finance     BOOLEAN DEFAULT FALSE,
  can_content     BOOLEAN DEFAULT FALSE,
  can_users       BOOLEAN DEFAULT FALSE,
  can_reports     BOOLEAN DEFAULT FALSE,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 3. STORES — المتاجر
-- ============================================================
CREATE TABLE stores (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name_ar             VARCHAR(100) NOT NULL,
  name_en             VARCHAR(100),
  description_ar      TEXT,
  description_en      TEXT,
  logo_url            VARCHAR(500),          -- Cloudinary
  cover_url           VARCHAR(500),
  category            VARCHAR(50) NOT NULL
                      CHECK (category IN ('clothing','shoes','accessories','phones','other')),
  package             VARCHAR(20) DEFAULT 'free'
                      CHECK (package IN ('free','featured','premium')),
  commission_rate     DECIMAL(4,2) DEFAULT 10.00, -- بين 5% و10%
  status              VARCHAR(20) DEFAULT 'pending'
                      CHECK (status IN ('pending','active','suspended','rejected','deleted')),
  is_open             BOOLEAN DEFAULT TRUE,
  open_hours          JSONB,                 -- {"sat":"10:00-23:00","fri":"14:00-23:00"}
  return_policy       TEXT,
  phone               VARCHAR(20),           -- للإدارة فقط
  address             TEXT,                  -- للإدارة فقط
  instagram           VARCHAR(100),
  tiktok              VARCHAR(100),
  whatsapp            VARCHAR(20),
  twitter             VARCHAR(100),
  sort_order          INTEGER DEFAULT 0,     -- ترتيب يدوي من الإدارة
  upload_by_admin     BOOLEAN DEFAULT FALSE, -- هل الإدارة ترفع الصور؟
  approved_at         TIMESTAMPTZ,
  approved_by         UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 4. STORE_EMPLOYEES — موظفو المتجر
-- ============================================================
CREATE TABLE store_employees (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_products    BOOLEAN DEFAULT FALSE,
  can_orders      BOOLEAN DEFAULT FALSE,
  can_inventory   BOOLEAN DEFAULT FALSE,
  can_coupons     BOOLEAN DEFAULT FALSE,
  can_reports     BOOLEAN DEFAULT FALSE,
  can_settings    BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(store_id, user_id)
);

-- ============================================================
-- 5. CATEGORIES — الفئات
-- ============================================================
CREATE TABLE categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name_ar     VARCHAR(80) NOT NULL,
  name_en     VARCHAR(80),
  parent_id   UUID REFERENCES categories(id),
  icon        VARCHAR(100),
  sort_order  INTEGER DEFAULT 0,
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 6. PRODUCTS — المنتجات
-- ============================================================
CREATE TABLE products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  category_id     UUID REFERENCES categories(id),
  name_ar         VARCHAR(200) NOT NULL,
  name_en         VARCHAR(200),
  description_ar  TEXT,
  description_en  TEXT,
  price           DECIMAL(10,3) NOT NULL,   -- بالدينار الكويتي
  price_before    DECIMAL(10,3),            -- سعر قبل الخصم
  sizes           TEXT[],                   -- ["XS","S","M","L","XL"]
  colors          TEXT[],                   -- ["أسود","أبيض","بيج"]
  status          VARCHAR(20) DEFAULT 'pending'
                  CHECK (status IN ('pending','active','rejected','hidden','deleted')),
  is_visible      BOOLEAN DEFAULT TRUE,     -- يُخفى عند نفاد المخزون
  sort_order      INTEGER DEFAULT 0,
  views_count     INTEGER DEFAULT 0,
  sales_count     INTEGER DEFAULT 0,
  avg_rating      DECIMAL(3,2) DEFAULT 0,
  approved_by     UUID REFERENCES users(id),
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 7. PRODUCT_MEDIA — صور وفيديوهات المنتج
-- ============================================================
CREATE TABLE product_media (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url           VARCHAR(500) NOT NULL,       -- Cloudinary URL
  type          VARCHAR(10) DEFAULT 'image'
                CHECK (type IN ('image','video')),
  is_primary    BOOLEAN DEFAULT FALSE,
  status        VARCHAR(20) DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected')),
  sort_order    INTEGER DEFAULT 0,
  approved_by   UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 8. INVENTORY — المخزون
-- ============================================================
CREATE TABLE inventory (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size            VARCHAR(20),
  color           VARCHAR(50),
  quantity        INTEGER NOT NULL DEFAULT 0,
  low_stock_alert INTEGER DEFAULT 5,        -- تنبيه عند الوصول لهذا الرقم
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(product_id, size, color)
);

-- ============================================================
-- 9. ADDRESSES — عناوين العملاء
-- ============================================================
CREATE TABLE addresses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       VARCHAR(50),                  -- منزل / عمل / غيره
  full_address TEXT NOT NULL,
  area        VARCHAR(100),
  block       VARCHAR(50),
  street      VARCHAR(100),
  building    VARCHAR(50),
  floor       VARCHAR(20),
  apartment   VARCHAR(20),
  phone       VARCHAR(20),
  is_default  BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 10. COUPONS — الكوبونات
-- ============================================================
CREATE TABLE coupons (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        UUID REFERENCES stores(id) ON DELETE CASCADE, -- NULL = كوبون عام من الإدارة
  code            VARCHAR(50) NOT NULL UNIQUE,
  discount_pct    DECIMAL(5,2) NOT NULL,    -- نسبة الخصم
  min_order       DECIMAL(10,3) DEFAULT 0,
  max_uses        INTEGER,                  -- NULL = غير محدود
  uses_count      INTEGER DEFAULT 0,
  specific_user   UUID REFERENCES users(id), -- NULL = للكل
  starts_at       TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  is_active       BOOLEAN DEFAULT TRUE,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 11. ORDERS — الطلبات
-- ============================================================
CREATE TABLE orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     UUID NOT NULL REFERENCES users(id),
  store_id        UUID NOT NULL REFERENCES stores(id),
  address_id      UUID REFERENCES addresses(id),
  coupon_id       UUID REFERENCES coupons(id),
  subtotal        DECIMAL(10,3) NOT NULL,
  discount        DECIMAL(10,3) DEFAULT 0,
  delivery_fee    DECIMAL(10,3) DEFAULT 0,
  total           DECIMAL(10,3) NOT NULL,
  payment_method  VARCHAR(30) NOT NULL
                  CHECK (payment_method IN ('cash','knet','tabby','tamara','taly')),
  payment_status  VARCHAR(20) DEFAULT 'pending'
                  CHECK (payment_status IN ('pending','paid','failed','refunded')),
  status          VARCHAR(30) DEFAULT 'pending'
                  CHECK (status IN ('pending','confirmed','preparing','assigned','in_delivery','delivered','cancelled','returned')),
  cancel_reason   TEXT,
  notes           TEXT,
  commission_rate DECIMAL(4,2),             -- نسخة من العمولة وقت الطلب
  commission_amt  DECIMAL(10,3),
  commission_paid BOOLEAN DEFAULT FALSE,
  driver_id       UUID REFERENCES users(id),
  assigned_at     TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 12. ORDER_ITEMS — منتجات الطلب
-- ============================================================
CREATE TABLE order_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES products(id),
  name_ar     VARCHAR(200) NOT NULL,        -- نسخة وقت الطلب
  price       DECIMAL(10,3) NOT NULL,
  quantity    INTEGER NOT NULL DEFAULT 1,
  size        VARCHAR(20),
  color       VARCHAR(50),
  total       DECIMAL(10,3) NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 13. ORDER_STATUS_LOG — سجل تغييرات حالة الطلب
-- ============================================================
CREATE TABLE order_status_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status VARCHAR(30),
  to_status   VARCHAR(30) NOT NULL,
  changed_by  UUID REFERENCES users(id),
  note        TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 14. DELIVERY_ASSIGNMENTS — تعيين السائقين للطلبات
-- ============================================================
CREATE TABLE delivery_assignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  driver_id       UUID NOT NULL REFERENCES users(id),
  assigned_by     UUID REFERENCES users(id), -- NULL = السائق أخذه بنفسه
  status          VARCHAR(20) DEFAULT 'active'
                  CHECK (status IN ('active','completed','returned','reassigned')),
  accepted_at     TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  UNIQUE(order_id, status)                   -- حماية التضارب: طلب واحد لسائق واحد
);

-- ============================================================
-- 15. DRIVERS — بيانات السائقين
-- ============================================================
CREATE TABLE drivers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  type            VARCHAR(20) DEFAULT 'freelance'
                  CHECK (type IN ('company','freelance')),
  area            VARCHAR(100),
  is_active       BOOLEAN DEFAULT TRUE,
  total_deliveries INTEGER DEFAULT 0,
  avg_rating      DECIMAL(3,2) DEFAULT 0,
  joined_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 16. REVIEWS — التقييمات
-- ============================================================
CREATE TABLE reviews (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES orders(id),
  customer_id UUID NOT NULL REFERENCES users(id),
  store_id    UUID NOT NULL REFERENCES stores(id),
  product_id  UUID REFERENCES products(id),
  rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(order_id, product_id)
);

-- ============================================================
-- 17. WISHLISTS — المفضلة
-- ============================================================
CREATE TABLE wishlists (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id  UUID REFERENCES products(id)  ON DELETE CASCADE,
  store_id    UUID REFERENCES stores(id)    ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  CHECK (
    (product_id IS NOT NULL AND store_id IS NULL) OR
    (store_id IS NOT NULL AND product_id IS NULL)
  ),
  UNIQUE(user_id, product_id),
  UNIQUE(user_id, store_id)
);

-- ============================================================
-- 18. BANNERS — البنرات الإعلانية
-- ============================================================
CREATE TABLE banners (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         VARCHAR(200),
  image_url     VARCHAR(500) NOT NULL,
  link_url      VARCHAR(500),
  placement     VARCHAR(30) NOT NULL
                CHECK (placement IN ('home_popup','home_banner','stores_page','product_page')),
  is_active     BOOLEAN DEFAULT TRUE,
  starts_at     TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  sort_order    INTEGER DEFAULT 0,
  clicks        INTEGER DEFAULT 0,
  views         INTEGER DEFAULT 0,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 19. NOTIFICATIONS — الإشعارات
-- ============================================================
CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        VARCHAR(30) NOT NULL
              CHECK (type IN ('order_update','new_offer','new_store','system')),
  title_ar    VARCHAR(200) NOT NULL,
  title_en    VARCHAR(200),
  body_ar     TEXT,
  body_en     TEXT,
  ref_id      UUID,                          -- order_id أو store_id حسب النوع
  ref_type    VARCHAR(30),
  is_read     BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 20. NOTIFICATION_SETTINGS — إعدادات الإشعارات
-- ============================================================
CREATE TABLE notification_settings (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  order_updates   BOOLEAN DEFAULT TRUE,
  new_offers      BOOLEAN DEFAULT TRUE,
  new_stores      BOOLEAN DEFAULT FALSE,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 21. STORE_VISITS — زيارات المتجر
-- ============================================================
CREATE TABLE store_visits (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id),
  visited_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 22. INVOICES — الفواتير
-- ============================================================
CREATE TABLE invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        UUID NOT NULL REFERENCES stores(id),
  period_from     DATE NOT NULL,
  period_to       DATE NOT NULL,
  total_orders    INTEGER DEFAULT 0,
  total_sales     DECIMAL(10,3) DEFAULT 0,
  commission_rate DECIMAL(4,2) NOT NULL,
  commission_due  DECIMAL(10,3) NOT NULL,
  status          VARCHAR(20) DEFAULT 'pending'
                  CHECK (status IN ('pending','paid','overdue')),
  paid_at         TIMESTAMPTZ,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INDEXES — الفهارس لتسريع الاستعلامات
-- ============================================================

-- Users
CREATE INDEX idx_users_phone   ON users(phone);
CREATE INDEX idx_users_email   ON users(email);
CREATE INDEX idx_users_role    ON users(role);

-- Stores
CREATE INDEX idx_stores_status   ON stores(status);
CREATE INDEX idx_stores_category ON stores(category);
CREATE INDEX idx_stores_package  ON stores(package);
CREATE INDEX idx_stores_is_open  ON stores(is_open);
CREATE INDEX idx_stores_owner    ON stores(owner_id);

-- Products
CREATE INDEX idx_products_store    ON products(store_id);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_status   ON products(status);
CREATE INDEX idx_products_sales    ON products(sales_count DESC);

-- Orders
CREATE INDEX idx_orders_customer  ON orders(customer_id);
CREATE INDEX idx_orders_store     ON orders(store_id);
CREATE INDEX idx_orders_status    ON orders(status);
CREATE INDEX idx_orders_driver    ON orders(driver_id);
CREATE INDEX idx_orders_created   ON orders(created_at DESC);

-- Delivery
CREATE INDEX idx_delivery_order   ON delivery_assignments(order_id);
CREATE INDEX idx_delivery_driver  ON delivery_assignments(driver_id);
CREATE INDEX idx_delivery_status  ON delivery_assignments(status);

-- Notifications
CREATE INDEX idx_notif_user   ON notifications(user_id);
CREATE INDEX idx_notif_unread ON notifications(user_id, is_read) WHERE is_read = FALSE;

-- ============================================================
-- FUNCTIONS — الدوال المساعدة
-- ============================================================

-- دالة تحديث updated_at تلقائياً
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- تطبيق الدالة على الجداول المطلوبة
CREATE TRIGGER trg_users_updated    BEFORE UPDATE ON users    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_stores_updated   BEFORE UPDATE ON stores   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_products_updated BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_orders_updated   BEFORE UPDATE ON orders   FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- دالة حماية التضارب عند استلام السائق للطلب
-- تُستخدم داخل Transaction في Node.js
-- BEGIN;
--   SELECT id FROM orders WHERE id = $1 AND status = 'pending' FOR UPDATE;
--   UPDATE orders SET status = 'assigned', driver_id = $2 WHERE id = $1 AND status = 'pending';
--   INSERT INTO delivery_assignments (order_id, driver_id) VALUES ($1, $2);
-- COMMIT;

-- دالة تحديث تقييم المنتج تلقائياً
CREATE OR REPLACE FUNCTION update_product_rating()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE products
  SET avg_rating = (
    SELECT ROUND(AVG(rating)::NUMERIC, 2)
    FROM reviews
    WHERE product_id = NEW.product_id
  )
  WHERE id = NEW.product_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_product_rating
AFTER INSERT OR UPDATE ON reviews
FOR EACH ROW EXECUTE FUNCTION update_product_rating();

-- دالة إخفاء المنتج عند نفاد المخزون
CREATE OR REPLACE FUNCTION check_inventory()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.quantity = 0 THEN
    UPDATE products SET is_visible = FALSE WHERE id = NEW.product_id;
  ELSIF OLD.quantity = 0 AND NEW.quantity > 0 THEN
    UPDATE products SET is_visible = TRUE WHERE id = NEW.product_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_inventory_check
AFTER UPDATE OF quantity ON inventory
FOR EACH ROW EXECUTE FUNCTION check_inventory();
