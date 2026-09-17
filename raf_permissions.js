/* ============================================================================
 * RAF Marketplace — RBAC (Role-Based Access Control) Core
 * ----------------------------------------------------------------------------
 * Prototype data layer + enforcement helper.
 *
 * DESIGN GOALS
 *  - Backend-ready: every entity maps 1:1 to a SQL table so this prototype can
 *    migrate to Supabase / PostgreSQL / Firebase / a custom API WITHOUT redesign.
 *  - Stable permission KEYS (e.g. "orders.refund"). The SAME keys are intended
 *    to drive backend enforcement (RLS policies / middleware), not just the UI.
 *  - Effective permission resolution:
 *        can(user, key) = (role.permissions ∪ user.grants) − user.revokes
 *
 * SUGGESTED RELATIONAL MAPPING
 *   raf_perm_catalog   -> permissions(key PK, module, action, label_ar, label_en)
 *   raf_roles          -> roles(id PK, name_ar, name_en, description, is_system)
 *                         role_permissions(role_id FK, permission_key FK)
 *   raf_users          -> users(id PK, name, email, phone, account_type,
 *                                status, reg_date, role_id FK)
 *                         user_permission_overrides(user_id FK, permission_key FK,
 *                                                   effect ENUM('grant','revoke'))
 *   raf_templates      -> permission_templates(id PK, name_ar, name_en, description)
 *                         template_permissions(template_id FK, permission_key FK)
 *
 * SECURITY NOTE
 *   Frontend hiding (RAFPerm.enforce) is convenience ONLY. Real enforcement must
 *   also happen server-side: check can(user,key) inside every API endpoint / RLS
 *   policy before returning or mutating data. Direct-URL / direct-API access must
 *   be rejected by the backend using these same permission keys.
 * ==========================================================================*/
(function (global) {
  'use strict';

  /* -------------------------------------------------------------------------
   * 1) PERMISSION CATALOG  (modules -> actions -> stable keys)
   * ---------------------------------------------------------------------- */
  var MODULES = [
    { id: 'users',       labelAr: 'المستخدمون',       labelEn: 'Users',                icon: 'ti-users',
      actions: ['view', 'create', 'edit', 'delete', 'suspend'] },
    { id: 'stores',      labelAr: 'المتاجر',          labelEn: 'Stores',               icon: 'ti-building-store',
      actions: ['view', 'approve', 'edit', 'delete'] },
    { id: 'products',    labelAr: 'المنتجات',         labelEn: 'Products',             icon: 'ti-box',
      actions: ['view', 'create', 'edit', 'delete'] },
    { id: 'orders',      labelAr: 'الطلبات',          labelEn: 'Orders',               icon: 'ti-shopping-bag',
      actions: ['view', 'manage', 'cancel', 'refund'] },
    { id: 'auctions',    labelAr: 'المزادات',         labelEn: 'Auctions',             icon: 'ti-gavel',
      actions: ['view', 'create', 'edit', 'delete', 'approve'] },
    { id: 'offers',      labelAr: 'العروض',           labelEn: 'Offers',               icon: 'ti-discount',
      actions: ['view', 'create', 'edit', 'delete'] },
    { id: 'drivers',     labelAr: 'السائقون',         labelEn: 'Drivers',              icon: 'ti-motorbike',
      actions: ['view', 'approve', 'suspend'] },
    { id: 'reports',     labelAr: 'التقارير',         labelEn: 'Reports',              icon: 'ti-chart-bar',
      actions: ['view', 'export'] },
    /* Customer Service. No existing key expresses "may work a support case":
       `orders.manage` is held by merchants, so reusing it would hand every
       store global Customer Service access. These five keys are the smallest
       set that separates reading a case, opening one, working it, ending it
       and escalating it. */
    { id: 'support',     labelAr: 'خدمة العملاء',     labelEn: 'Customer Service',     icon: 'ti-headset',
      actions: ['view', 'create', 'manage', 'resolve', 'escalate'] },
    { id: 'settings',    labelAr: 'إعدادات النظام',   labelEn: 'System Settings',      icon: 'ti-settings',
      actions: ['view', 'edit'] },
    { id: 'permissions', labelAr: 'إدارة الصلاحيات',  labelEn: 'Permissions Mgmt',     icon: 'ti-shield-lock',
      actions: ['view', 'edit'] }
  ];

  var ACTION_LABELS = {
    view:    { ar: 'عرض',      en: 'View' },
    create:  { ar: 'إنشاء',    en: 'Create' },
    edit:    { ar: 'تعديل',    en: 'Edit' },
    delete:  { ar: 'حذف',      en: 'Delete' },
    suspend: { ar: 'إيقاف',    en: 'Suspend' },
    approve: { ar: 'اعتماد',   en: 'Approve' },
    manage:  { ar: 'إدارة',    en: 'Manage' },
    cancel:  { ar: 'إلغاء',    en: 'Cancel' },
    refund:  { ar: 'استرجاع',  en: 'Refund' },
    export:  { ar: 'تصدير',    en: 'Export' },
    resolve: { ar: 'إنهاء',    en: 'Resolve' },
    escalate:{ ar: 'تصعيد',    en: 'Escalate' }
  };

  function buildCatalog() {
    var cat = [];
    MODULES.forEach(function (m) {
      m.actions.forEach(function (a) {
        var al = ACTION_LABELS[a] || { ar: a, en: a };
        cat.push({
          key: m.id + '.' + a,
          module: m.id,
          action: a,
          labelAr: al.ar + ' ' + m.labelAr,
          labelEn: al.en + ' ' + m.labelEn
        });
      });
    });
    return cat;
  }
  var CATALOG = buildCatalog();
  var ALL_KEYS = CATALOG.map(function (p) { return p.key; });

  /* helper: collect every key for a list of modules */
  function keysFor(modules) {
    return CATALOG.filter(function (p) { return modules.indexOf(p.module) !== -1; })
                  .map(function (p) { return p.key; });
  }
  /* helper: only the read keys for a list of modules */
  function viewKeysFor(modules) {
    return modules.map(function (m) { return m + '.view'; });
  }

  /* -------------------------------------------------------------------------
   * 2) ROLES  (predefined — id is stable, used as foreign key)
   * ---------------------------------------------------------------------- */
  var ROLES = [
    {
      id: 'super_admin', nameAr: 'مدير عام', nameEn: 'Super Admin', system: true,
      descAr: 'صلاحيات كاملة على جميع وحدات النظام', descEn: 'Full unrestricted access to every module',
      permissions: ALL_KEYS.slice()
    },
    {
      id: 'higher_mgmt', nameAr: 'الإدارة العليا', nameEn: 'Higher Management', system: true,
      descAr: 'إشراف كامل عدا إدارة الصلاحيات الحساسة', descEn: 'Broad oversight, excludes sensitive permission edits',
      permissions: ALL_KEYS.filter(function (k) { return k !== 'permissions.edit' && k !== 'settings.edit'; })
    },
    {
      id: 'ops_manager', nameAr: 'مدير العمليات', nameEn: 'Operations Manager', system: true,
      descAr: 'إدارة الطلبات والمتاجر والسائقين والمنتجات', descEn: 'Runs orders, stores, drivers and products',
      permissions: keysFor(['orders', 'stores', 'drivers', 'products'])
        .concat(['users.view', 'reports.view', 'reports.export', 'auctions.view', 'offers.view'])
        /* Logistics is a destination department for a support case: it reads and
           works the case it receives. Ending the case and talking to the
           customer stay with Customer Service. */
        .concat(['support.view', 'support.manage'])
    },
    {
      id: 'customer_service', nameAr: 'خدمة العملاء', nameEn: 'Customer Service', system: true,
      descAr: 'متابعة الطلبات ودعم العملاء', descEn: 'Handles orders and customer support',
      permissions: ['users.view', 'orders.view', 'orders.manage', 'orders.cancel',
                    'stores.view', 'products.view', 'drivers.view', 'auctions.view', 'offers.view',
                    /* the department that runs Customer Service */
                    'support.view', 'support.create', 'support.manage', 'support.resolve', 'support.escalate']
    },
    {
      id: 'finance', nameAr: 'المالية', nameEn: 'Finance', system: true,
      descAr: 'المدفوعات والاستردادات والتقارير المالية', descEn: 'Payments, refunds and financial reporting',
      permissions: ['orders.view', 'orders.refund', 'reports.view', 'reports.export',
                    'stores.view', 'users.view',
                    /* Finance is a destination department for a payment case only:
                       it reads and works the case it receives. It gains no
                       Reports Center or Performance access from this. */
                    'support.view', 'support.manage']
    },
    {
      id: 'marketing', nameAr: 'التسويق', nameEn: 'Marketing', system: true,
      descAr: 'إدارة العروض والمزادات والحملات', descEn: 'Manages offers, auctions and campaigns',
      permissions: keysFor(['offers', 'auctions'])
        .concat(['products.view', 'stores.view', 'reports.view'])
    },
    {
      id: 'merchant', nameAr: 'تاجر', nameEn: 'Merchant', system: true,
      descAr: 'إدارة متجره ومنتجاته وطلباته', descEn: 'Owns a store: products and own orders',
      permissions: ['stores.view', 'stores.edit', 'products.view', 'products.create',
                    'products.edit', 'products.delete', 'orders.view', 'orders.manage',
                    'offers.view', 'offers.create', 'offers.edit', 'offers.delete',
                    'auctions.view', 'auctions.create', 'reports.view', 'reports.export']
    },
    {
      id: 'merchant_employee', nameAr: 'موظف تاجر', nameEn: 'Merchant Employee', system: true,
      descAr: 'مساعدة التاجر بصلاحيات محدودة', descEn: 'Assists a merchant with limited scope',
      permissions: ['stores.view', 'products.view', 'products.create', 'products.edit',
                    'orders.view', 'orders.manage', 'offers.view']
    },
    {
      id: 'driver', nameAr: 'سائق', nameEn: 'Driver', system: true,
      descAr: 'استلام وتوصيل الطلبات المسندة', descEn: 'Receives and delivers assigned orders',
      permissions: ['orders.view']
    },
    {
      id: 'customer', nameAr: 'عميل', nameEn: 'Customer', system: true,
      descAr: 'مستخدم عادي بدون صلاحيات إدارية', descEn: 'Standard shopper, no admin access',
      permissions: []
    }
  ];

  /* -------------------------------------------------------------------------
   * 3) USERS  (18 seeded — reflects the RAF org structure)
   * ---------------------------------------------------------------------- */
  /* `storeSlug` is the canonical merchant ↔ store relationship. A merchant or
     merchant employee belongs to exactly one store and never picks it by hand;
     every merchant-side surface scopes its data through this field. It is the
     ONLY accepted way to resolve a store — never by display name, email or
     username. Null for every non-merchant account. */
  function u(id, name, email, phone, accountType, roleId, status, regDate, overrides, storeSlug) {
    return {
      id: id, name: name, email: email, phone: phone,
      accountType: accountType, roleId: roleId, status: status,
      regDate: regDate, overrides: overrides || {},
      storeSlug: storeSlug || null
    };
  }
  var USERS = [
    /* 1 Super Admin */
    u('usr-001', 'أحمد المنصور', 'a.mansour@raf.kw', '+965 9000 1001', 'staff', 'super_admin', 'active', '2023-01-05'),
    /* 2 Higher Management */
    u('usr-002', 'فاطمة العلي', 'f.ali@raf.kw', '+965 9000 1002', 'staff', 'higher_mgmt', 'active', '2023-02-12'),
    u('usr-003', 'عبدالله الراشد', 'a.rashed@raf.kw', '+965 9000 1003', 'staff', 'higher_mgmt', 'active', '2023-03-01'),
    /* 2 Operations */
    u('usr-004', 'يوسف البدر', 'y.badr@raf.kw', '+965 9000 1004', 'staff', 'ops_manager', 'active', '2023-04-18'),
    u('usr-005', 'منى الخالدي', 'm.khaled@raf.kw', '+965 9000 1005', 'staff', 'ops_manager', 'active', '2023-05-22',
      { 'auctions.approve': 'grant', 'orders.refund': 'revoke' }),
    /* 2 Customer Service */
    u('usr-006', 'سارة الفهد', 's.fahad@raf.kw', '+965 9000 1006', 'staff', 'customer_service', 'active', '2023-06-09'),
    u('usr-007', 'خالد العتيبي', 'k.otaibi@raf.kw', '+965 9000 1007', 'staff', 'customer_service', 'suspended', '2023-07-15'),
    /* 1 Finance */
    u('usr-008', 'نورة السالم', 'n.salem@raf.kw', '+965 9000 1008', 'staff', 'finance', 'active', '2023-08-03'),
    /* 1 Marketing */
    u('usr-009', 'فيصل المطيري', 'f.mutairi@raf.kw', '+965 9000 1009', 'staff', 'marketing', 'active', '2023-09-27'),
    /* 2 Merchants */
    u('usr-010', 'متجر كازا مود', 'casa.mode@raf.kw', '+965 9000 1010', 'merchant', 'merchant', 'active', '2023-10-11',
      { 'auctions.edit': 'grant' }, 'casa-mode'),
    /* UNASSIGNED — «لمسة ذهب» matches no store in RAFSource. Deliberately left
       null: an account is never pointed at a different store to fill the gap. */
    u('usr-011', 'متجر لمسة ذهب', 'lamset.gold@raf.kw', '+965 9000 1011', 'merchant', 'merchant', 'active', '2023-11-30',
      null, null),
    /* 2 Merchant Employees — UNASSIGNED. Nothing in the data states which store
       either works for; an email domain is not a store reference. */
    u('usr-012', 'ريم الدوسري', 'reem.d@casa.kw', '+965 9000 1012', 'merchant', 'merchant_employee', 'active', '2024-01-08',
      null, null),
    u('usr-013', 'طلال الشمري', 'talal.s@lamset.kw', '+965 9000 1013', 'merchant', 'merchant_employee', 'active', '2024-02-19',
      null, null),
    /* 2 Drivers */
    u('usr-014', 'ماجد العنزي', 'majed.driver@raf.kw', '+965 9000 1014', 'driver', 'driver', 'active', '2024-03-14'),
    u('usr-015', 'حمد القحطاني', 'hamad.driver@raf.kw', '+965 9000 1015', 'driver', 'driver', 'suspended', '2024-04-02'),
    /* 3 Customers */
    u('usr-016', 'محمد العنزي', 'm.anzi@gmail.com', '+965 99096686', 'customer', 'customer', 'active', '2024-05-21'),
    u('usr-017', 'دانة الصباح', 'dana.s@gmail.com', '+965 9000 1017', 'customer', 'customer', 'active', '2024-06-17'),
    u('usr-018', 'عبدالعزيز الحربي', 'a.harbi@gmail.com', '+965 9000 1018', 'customer', 'customer', 'active', '2024-07-09')
  ];

  /* -------------------------------------------------------------------------
   * 4) PERMISSION TEMPLATES  (reusable presets)
   * ---------------------------------------------------------------------- */
  var TEMPLATES = [
    {
      id: 'tpl_std_merchant', nameAr: 'تاجر قياسي', nameEn: 'Standard Merchant',
      descAr: 'صلاحيات المتجر والمنتجات والطلبات الأساسية', descEn: 'Core store, products and orders access',
      permissions: ['stores.view', 'stores.edit', 'products.view', 'products.create',
                    'products.edit', 'products.delete', 'orders.view', 'orders.manage', 'offers.view']
    },
    {
      id: 'tpl_senior_merchant', nameAr: 'تاجر متقدم', nameEn: 'Senior Merchant',
      descAr: 'صلاحيات التاجر القياسي مع العروض والمزادات', descEn: 'Standard merchant plus offers and auctions',
      permissions: ['stores.view', 'stores.edit', 'products.view', 'products.create', 'products.edit',
                    'products.delete', 'orders.view', 'orders.manage', 'offers.view', 'offers.create',
                    'offers.edit', 'offers.delete', 'auctions.view', 'auctions.create', 'reports.view']
    },
    {
      id: 'tpl_cs_agent', nameAr: 'موظف دعم عملاء', nameEn: 'Customer Support Agent',
      descAr: 'متابعة الطلبات ودعم المستخدمين', descEn: 'Order follow-up and user support',
      permissions: ['users.view', 'orders.view', 'orders.manage', 'orders.cancel',
                    'stores.view', 'products.view', 'drivers.view']
    },
    {
      id: 'tpl_finance_officer', nameAr: 'موظف مالية', nameEn: 'Finance Officer',
      descAr: 'الاستردادات والتقارير المالية', descEn: 'Refunds and financial reports',
      permissions: ['orders.view', 'orders.refund', 'reports.view', 'reports.export', 'users.view']
    },
    {
      id: 'tpl_regional_manager', nameAr: 'مدير إقليمي', nameEn: 'Regional Manager',
      descAr: 'إشراف على العمليات والمتاجر والسائقين', descEn: 'Oversees operations, stores and drivers',
      permissions: keysFor(['orders', 'stores', 'drivers'])
        .concat(['products.view', 'products.edit', 'users.view', 'reports.view', 'reports.export'])
    }
  ];

  /* -------------------------------------------------------------------------
   * 5) STORAGE  (seed-once; never clobber edited data)
   * ---------------------------------------------------------------------- */
  var LS = {
    catalog:   'raf_perm_catalog',
    roles:     'raf_roles',
    users:     'raf_users',
    templates: 'raf_templates',
    session:   'raf_current_user',  /* id of the acting staff member (demo) */
    migrations:'raf_perm_migrations'
  };

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  function seed(force) {
    if (force || !localStorage.getItem(LS.catalog))   write(LS.catalog, CATALOG);
    else /* catalog is derived/static — always refresh to stay in sync */     write(LS.catalog, CATALOG);
    if (force || !localStorage.getItem(LS.roles))     write(LS.roles, ROLES);
    if (force || !localStorage.getItem(LS.users))     write(LS.users, USERS);
    if (force || !localStorage.getItem(LS.templates)) write(LS.templates, TEMPLATES);
    /* Seeding creates ACCOUNT RECORDS, never a SESSION. Loading this script
       used to sign the visitor in as the first administrator, so any page that
       included it treated an anonymous browser as staff. Accounts are data;
       being signed in is an act. Only the login flow performs that act, through
       setCurrentUser(), and a browser that has never signed in stays anonymous. */
    backfillStoreSlugs();
    migrateRoles();
  }

  /* Roles are seeded once, so a permission later added to a role's seed never
     reaches a role that was already stored. Each migration below runs exactly
     once and is recorded; an admin who afterwards revokes the key from that
     role is never overridden. */
  var ROLE_MIGRATIONS = [
    /* merchants export their own store's reports */
    { id:'merchant_reports_export_v1', roleId:'merchant', add:['reports.export'] },
    /* Customer Service — the support module reaches roles that were already
       seeded. Deliberately NOT applied to merchant, merchant_employee,
       marketing, driver or customer: none of them works a RAF support case. */
    { id:'support_customer_service_v1', roleId:'customer_service',
      add:['support.view', 'support.create', 'support.manage', 'support.resolve', 'support.escalate'] },
    { id:'support_ops_manager_v1',  roleId:'ops_manager',  add:['support.view', 'support.manage'] },
    { id:'support_finance_v1',      roleId:'finance',      add:['support.view', 'support.manage'] },
    { id:'support_higher_mgmt_v1',  roleId:'higher_mgmt',
      add:['support.view', 'support.create', 'support.manage', 'support.resolve', 'support.escalate'] },
    { id:'support_super_admin_v1',  roleId:'super_admin',
      add:['support.view', 'support.create', 'support.manage', 'support.resolve', 'support.escalate'] }
  ];
  function migrateRoles() {
    try {
      var done = read(LS.migrations, []);
      if (!Array.isArray(done)) done = [];
      var roles = read(LS.roles, null);
      if (!Array.isArray(roles)) return;
      var changed = false, ran = false;
      ROLE_MIGRATIONS.forEach(function (m) {
        if (done.indexOf(m.id) > -1) return;
        roles.forEach(function (r) {
          if (r.id !== m.roleId || !Array.isArray(r.permissions)) return;
          m.add.forEach(function (k) {
            if (r.permissions.indexOf(k) === -1) { r.permissions.push(k); changed = true; }
          });
        });
        done.push(m.id); ran = true;
      });
      if (changed) write(LS.roles, roles);
      if (ran) write(LS.migrations, done);
    } catch (e) {}
  }

  /* Accounts stored before the merchant ↔ store link existed have no
     storeSlug. Backfill them from the seed by id, without disturbing any
     other edit an admin may have made to those records. */
  function backfillStoreSlugs() {
    try {
      var stored = read(LS.users, null);
      if (!Array.isArray(stored)) return;
      var seedBySlug = {};
      USERS.forEach(function (su) { if (su.storeSlug) seedBySlug[su.id] = su.storeSlug; });
      var changed = false;
      stored.forEach(function (su) {
        /* only fill in the field where it never existed. An explicit null means
           "no store assigned" and is left exactly as it is — never re-guessed. */
        if (su.storeSlug === undefined) { su.storeSlug = seedBySlug[su.id] || null; changed = true; }
      });
      if (changed) write(LS.users, stored);
    } catch (e) {}
  }

  /* -------------------------------------------------------------------------
   * 6) ACCESSORS
   * ---------------------------------------------------------------------- */
  function getCatalog()   { return read(LS.catalog, CATALOG); }
  function getModules()   { return MODULES.slice(); }
  function getRoles()     { return read(LS.roles, ROLES); }
  function getUsers()     { return read(LS.users, USERS); }
  function getTemplates() { return read(LS.templates, TEMPLATES); }

  function getRole(roleId) {
    return getRoles().filter(function (r) { return r.id === roleId; })[0] || null;
  }
  function getUser(userId) {
    return getUsers().filter(function (uu) { return uu.id === userId; })[0] || null;
  }
  /* The signed-in account, or null. There is no default identity: with no
     stored session nobody is signed in, so every caller either handles an
     anonymous visitor or refuses them. */
  function currentUser() {
    return getUser(read(LS.session, null));
  }

  function saveRole(role) {
    var roles = getRoles();
    var i = roles.findIndex(function (r) { return r.id === role.id; });
    if (i >= 0) roles[i] = role; else roles.push(role);
    write(LS.roles, roles);
  }
  function saveUser(user) {
    var users = getUsers();
    var i = users.findIndex(function (uu) { return uu.id === user.id; });
    if (i >= 0) users[i] = user; else users.push(user);
    write(LS.users, users);
  }
  function saveTemplate(tpl) {
    var tpls = getTemplates();
    var i = tpls.findIndex(function (t) { return t.id === tpl.id; });
    if (i >= 0) tpls[i] = tpl; else tpls.push(tpl);
    write(LS.templates, tpls);
  }
  function setCurrentUser(userId) { write(LS.session, userId); }

  /* -------------------------------------------------------------------------
   * 6b) NARROW ACCOUNT MUTATIONS
   * -------------------------------------------------------------------------
   * saveUser() above replaces a whole user record. That is right for the
   * permissions administration screen, which edits the whole record on
   * purpose, and wrong for every other surface: a narrow change ("suspend
   * this driver", "fix this phone number") must not be able to carry a role,
   * an override or a store link along with it.
   *
   * These two operations are the safe path. They read the STORED record, copy
   * only the fields named below onto it, and write it back. Identity and
   * authorisation fields — id, accountType, roleId, overrides, storeSlug,
   * regDate — are never taken from the caller and cannot be reached through
   * here at all, whatever the caller passes. Authorisation itself is NOT
   * decided here: the calling authority proves the actor may do this first.
   * ---------------------------------------------------------------------- */
  var PROFILE_FIELDS = ['name', 'email', 'phone'];
  var STATUSES = ['active', 'suspended'];

  function updateProfile(userId, patch) {
    var users = getUsers();
    var i = users.findIndex(function (u) { return u.id === userId; });
    if (i < 0) return { ok: false, reason: 'user_not_found' };
    var keys = Object.keys(patch || {});
    if (!keys.length) return { ok: false, reason: 'nothing_to_update' };
    for (var k = 0; k < keys.length; k++)
      if (PROFILE_FIELDS.indexOf(keys[k]) < 0) return { ok: false, reason: 'field_not_updatable', field: keys[k] };

    var next = Object.assign({}, users[i]);
    PROFILE_FIELDS.forEach(function (f) {
      if (patch[f] !== undefined) next[f] = String(patch[f]);
    });
    users[i] = next;
    write(LS.users, users);
    /* readback: the record that now exists, not the one we hoped for */
    var saved = getUser(userId);
    return saved ? { ok: true, user: saved } : { ok: false, reason: 'persist_failed' };
  }
  function setStatus(userId, status) {
    if (STATUSES.indexOf(status) < 0) return { ok: false, reason: 'invalid_status' };
    var users = getUsers();
    var i = users.findIndex(function (u) { return u.id === userId; });
    if (i < 0) return { ok: false, reason: 'user_not_found' };
    var next = Object.assign({}, users[i]);
    next.status = status;
    users[i] = next;
    write(LS.users, users);
    var saved = getUser(userId);
    if (!saved || saved.status !== status) return { ok: false, reason: 'persist_failed' };
    return { ok: true, user: saved };
  }
  /* Account creation. The id is generated HERE, in the project's existing
     `usr-0NN` shape, from the accounts that actually exist — never supplied by
     a caller and never derived from an array length, so a deleted account can
     never hand its id to somebody new. accountType and roleId are chosen by
     the calling authority from its own fixed values, never forwarded from a
     browser, and no other field is accepted. */
  function nextUserId() {
    var used = {}, max = 0;
    getUsers().forEach(function (u) {
      used[u.id] = 1;
      var m = /^usr-(\d+)$/.exec(u.id || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    var n = max + 1, id;
    do { id = 'usr-' + String(n).padStart(3, '0'); n++; } while (used[id]);
    return id;
  }
  function createAccount(spec) {
    spec = spec || {};
    if (!spec.accountType || !spec.roleId) return { ok: false, reason: 'account_type_required' };
    if (!getRole(spec.roleId)) return { ok: false, reason: 'role_not_found' };
    var id = nextUserId();
    var user = u(id, String(spec.name || ''), String(spec.email || ''), String(spec.phone || ''),
                 spec.accountType, spec.roleId, 'active',
                 new Date().toISOString().slice(0, 10), null, null);
    var users = getUsers();
    if (users.some(function (x) { return x.id === id; })) return { ok: false, reason: 'id_collision' };
    users.push(user);
    write(LS.users, users);
    var saved = getUser(id);
    if (!saved) return { ok: false, reason: 'persist_failed' };
    return { ok: true, user: saved };
  }

  /* -------------------------------------------------------------------------
   * 7) RESOLUTION  ——  can(user, key) = (role ∪ grants) − revokes
   * ---------------------------------------------------------------------- */
  function resolveUser(userOrId) {
    var user = (typeof userOrId === 'string') ? getUser(userOrId) : userOrId;
    if (!user) return null;
    return user;
  }

  /* origin of a permission for a user: 'role' | 'grant' | 'revoke' | 'none' */
  function originOf(userOrId, key) {
    var user = resolveUser(userOrId);
    if (!user) return 'none';
    var ov = user.overrides || {};
    if (ov[key] === 'revoke') return 'revoke';
    if (ov[key] === 'grant') return 'grant';
    var role = getRole(user.roleId);
    if (role && role.permissions.indexOf(key) !== -1) return 'role';
    return 'none';
  }

  function can(userOrId, key) {
    var o = originOf(userOrId, key);
    return o === 'role' || o === 'grant';
  }

  /* effective permission key list for a user */
  function effectivePermissions(userOrId) {
    var user = resolveUser(userOrId);
    if (!user) return [];
    var role = getRole(user.roleId);
    var set = {};
    (role ? role.permissions : []).forEach(function (k) { set[k] = true; });
    var ov = user.overrides || {};
    Object.keys(ov).forEach(function (k) {
      if (ov[k] === 'grant') set[k] = true;
      else if (ov[k] === 'revoke') delete set[k];
    });
    return Object.keys(set);
  }

  /* set / clear an override for a user (effect: 'grant' | 'revoke' | null) */
  function setOverride(userId, key, effect) {
    var user = getUser(userId);
    if (!user) return;
    user.overrides = user.overrides || {};
    if (effect === 'grant' || effect === 'revoke') user.overrides[key] = effect;
    else delete user.overrides[key];
    saveUser(user);
  }

  /* -------------------------------------------------------------------------
   * 8) FRONTEND ENFORCEMENT  (convenience only — back up server-side!)
   *    Usage in markup:
   *      <button data-perm="orders.refund"> ... </button>
   *      <section data-perm="reports.view"> ... </section>
   *      <body data-perm-guard="permissions.view" data-perm-redirect="raf_login.html">
   * ---------------------------------------------------------------------- */
  /* ---- merchant ↔ store resolution ----
     The single accepted way for a merchant surface to learn which store it is
     looking at. Resolution is by stored id only; display name, email and
     username are never consulted. */
  function isMerchant(userOrId) {
    var user = resolveUser(userOrId || read(LS.session, null));
    return !!(user && (user.roleId === 'merchant' || user.roleId === 'merchant_employee'));
  }
  function storeSlugOf(userOrId) {
    var user = resolveUser(userOrId || read(LS.session, null));
    return (user && user.storeSlug) || null;
  }
  /* The store record itself, straight from the central authority.
     Never falls back: an account with no link, or a link pointing at a store
     that does not exist, resolves to null. It is never silently pointed at
     some other store. */
  function storeOf(userOrId) {
    var slug = storeSlugOf(userOrId);
    if (!slug || !global.RAFSource) return null;
    return global.RAFSource.store(slug) || null;
  }
  /* Explicit link state, so a surface can tell "no store assigned" apart from
     "assigned to a store that is missing" and report it as the data problem it
     is instead of guessing. reason: null | 'unassigned' | 'store_not_found'. */
  function storeLinkOf(userOrId) {
    var user = resolveUser(userOrId || read(LS.session, null));
    var slug = (user && user.storeSlug) || null;
    if (!slug) return { slug:null, store:null, ok:false, reason:'unassigned' };
    var store = global.RAFSource ? global.RAFSource.store(slug) : null;
    if (!store) return { slug:slug, store:null, ok:false, reason:'store_not_found' };
    return { slug:slug, store:store, ok:true, reason:null };
  }

  function enforce(userOrId) {
    var user = resolveUser(userOrId || read(LS.session, null));
    /* page-level guard */
    var guard = document.body ? document.body.getAttribute('data-perm-guard') : null;
    if (guard && user && !can(user, guard)) {
      var to = document.body.getAttribute('data-perm-redirect');
      if (to) { window.location = to; return; }
      document.body.innerHTML = '<div style="padding:60px;text-align:center;font-family:sans-serif;color:#888;">'
        + '<h2>غير مصرّح بالوصول / Access Denied</h2>'
        + '<p>لا تملك صلاحية عرض هذه الصفحة.</p></div>';
      return;
    }
    /* element-level gating */
    document.querySelectorAll('[data-perm]').forEach(function (el) {
      var key = el.getAttribute('data-perm');
      var ok = user ? can(user, key) : false;
      el.style.display = ok ? '' : 'none';
    });
  }

  /* -------------------------------------------------------------------------
   * 9) PUBLIC API
   * ---------------------------------------------------------------------- */
  var RAFPerm = {
    LS: LS,
    MODULES: MODULES,
    ACTION_LABELS: ACTION_LABELS,
    seed: seed,
    reset: function () { seed(true); },
    /* accessors */
    getCatalog: getCatalog,
    getModules: getModules,
    getRoles: getRoles,
    getUsers: getUsers,
    getTemplates: getTemplates,
    getRole: getRole,
    getUser: getUser,
    currentUser: currentUser,
    setCurrentUser: setCurrentUser,
    /* mutators */
    saveRole: saveRole,
    saveUser: saveUser,
    /* narrow, field-scoped account mutations (see section 6b) */
    PROFILE_FIELDS: PROFILE_FIELDS,
    updateProfile: updateProfile, setStatus: setStatus, createAccount: createAccount,
    saveTemplate: saveTemplate,
    setOverride: setOverride,
    /* resolution */
    can: can,
    originOf: originOf,
    effectivePermissions: effectivePermissions,
    storeSlugOf: storeSlugOf,
    storeOf: storeOf,
    storeLinkOf: storeLinkOf,
    isMerchant: isMerchant,
    /* enforcement */
    enforce: enforce
  };

  /* auto-seed on load so any page including this script has the data ready */
  seed(false);

  global.RAFPerm = RAFPerm;
})(window);
