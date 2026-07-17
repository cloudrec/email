-- 0008_lead_warehouse.sql
-- Lead Warehouse: permanent B2B lead intelligence database.
-- Safety: no sending, no activation, no deletion by default.

SET NAMES utf8mb4;

-- 1. industry_taxonomy (self-referential)
CREATE TABLE IF NOT EXISTS industry_taxonomy (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  parent_id     BIGINT UNSIGNED NULL,
  slug          VARCHAR(80) NOT NULL,
  name_en       VARCHAR(200) NOT NULL,
  name_ru       VARCHAR(200) NOT NULL,
  name_uk       VARCHAR(200) NOT NULL,
  description_en VARCHAR(500) NULL,
  description_ru VARCHAR(500) NULL,
  description_uk VARCHAR(500) NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_it_slug (slug),
  KEY idx_it_parent (parent_id),
  CONSTRAINT fk_it_parent FOREIGN KEY (parent_id) REFERENCES industry_taxonomy(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. companies
CREATE TABLE IF NOT EXISTS companies (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  canonical_domain  VARCHAR(255) NOT NULL,
  name              VARCHAR(300) NULL,
  normalized_name   VARCHAR(300) NULL,
  country           CHAR(2) NULL,
  city              VARCHAR(150) NULL,
  address           VARCHAR(500) NULL,
  language          CHAR(5) NULL,
  category_primary  VARCHAR(80) NULL,
  category_secondary VARCHAR(80) NULL,
  description       TEXT NULL,
  source_count      INT UNSIGNED NOT NULL DEFAULT 0,
  first_seen_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  status            ENUM('active','inactive','duplicate','suppressed','legal_deleted') NOT NULL DEFAULT 'active',
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_co_domain (canonical_domain),
  KEY idx_co_status (status),
  KEY idx_co_country_city (country, city),
  KEY idx_co_category (category_primary)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. company_websites
CREATE TABLE IF NOT EXISTS company_websites (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id        BIGINT UNSIGNED NOT NULL,
  url               VARCHAR(2000) NOT NULL,
  domain            VARCHAR(255) NOT NULL,
  normalized_url    VARCHAR(2000) NULL,
  page_title        VARCHAR(500) NULL,
  meta_description  TEXT NULL,
  language_detected CHAR(5) NULL,
  source_provider   VARCHAR(60) NULL,
  first_seen_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  analyzed_at       TIMESTAMP NULL,
  status            ENUM('active','unreachable','blocked','non_html','duplicate','inactive') NOT NULL DEFAULT 'active',
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_cw_url (company_id, url(500)),
  KEY idx_cw_domain (domain),
  KEY idx_cw_status (status),
  CONSTRAINT fk_cw_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. contact_points
CREATE TABLE IF NOT EXISTS contact_points (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id         BIGINT UNSIGNED NOT NULL,
  website_id         BIGINT UNSIGNED NULL,
  type               ENUM('email','phone','telegram','whatsapp','contact_form','social') NOT NULL DEFAULT 'email',
  value              VARCHAR(500) NOT NULL,
  normalized_value   VARCHAR(500) NOT NULL,
  email_domain       VARCHAR(255) NULL,
  role_type          ENUM('info','sales','support','partnerships','owner','manager','generic','personal','unknown') NOT NULL DEFAULT 'unknown',
  status             ENUM('discovered','verified','invalid','risky','bounced','complained','unsubscribed','suppressed','do_not_contact','legal_deleted') NOT NULL DEFAULT 'discovered',
  verification_score TINYINT UNSIGNED NULL,
  source_url         VARCHAR(2000) NULL,
  context_snippet    VARCHAR(500) NULL,
  first_seen_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  verified_at        TIMESTAMP NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_cp_type_val_co (type, normalized_value(200), company_id),
  KEY idx_cp_company (company_id),
  KEY idx_cp_status (status),
  KEY idx_cp_type (type),
  KEY idx_cp_email_domain (email_domain),
  CONSTRAINT fk_cp_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT fk_cp_website FOREIGN KEY (website_id) REFERENCES company_websites(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. company_industries
CREATE TABLE IF NOT EXISTS company_industries (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id  BIGINT UNSIGNED NOT NULL,
  industry_id BIGINT UNSIGNED NOT NULL,
  confidence  DECIMAL(4,3) NOT NULL DEFAULT 0.500,
  source      ENUM('osm','tavily','website_analysis','manual','ai_classifier') NOT NULL DEFAULT 'website_analysis',
  is_primary  TINYINT(1) NOT NULL DEFAULT 0,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ci (company_id, industry_id),
  KEY idx_ci_industry (industry_id),
  CONSTRAINT fk_ci_company  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT fk_ci_industry FOREIGN KEY (industry_id) REFERENCES industry_taxonomy(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Extend tenant_product_profiles with warehouse fields
ALTER TABLE tenant_product_profiles
  ADD COLUMN IF NOT EXISTS product_key           VARCHAR(100) NULL AFTER id,
  ADD COLUMN IF NOT EXISTS target_industries_json JSON NULL AFTER forbidden_claims,
  ADD COLUMN IF NOT EXISTS status ENUM('active','archived','draft') NOT NULL DEFAULT 'active' AFTER is_default;

-- Add index on product_key if not exists
ALTER TABLE tenant_product_profiles
  ADD KEY IF NOT EXISTS idx_tpp_product_key (product_key);

-- 7. company_product_fit
CREATE TABLE IF NOT EXISTS company_product_fit (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id          BIGINT UNSIGNED NOT NULL,
  product_profile_id  BIGINT UNSIGNED NULL,
  product_key         VARCHAR(100) NULL,
  fit_score           DECIMAL(4,3) NOT NULL DEFAULT 0.000,
  confidence          DECIMAL(4,3) NOT NULL DEFAULT 0.000,
  fit_reason          VARCHAR(1000) NULL,
  detected_pains_json JSON NULL,
  recommended_angle   VARCHAR(500) NULL,
  status              ENUM('unknown','good_fit','weak_fit','not_fit','rejected_for_now') NOT NULL DEFAULT 'unknown',
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_cpf (company_id, product_key),
  KEY idx_cpf_product (product_key),
  KEY idx_cpf_status (status),
  CONSTRAINT fk_cpf_company  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT fk_cpf_profile  FOREIGN KEY (product_profile_id) REFERENCES tenant_product_profiles(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. contact_product_preferences
CREATE TABLE IF NOT EXISTS contact_product_preferences (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  contact_point_id   BIGINT UNSIGNED NOT NULL,
  company_id         BIGINT UNSIGNED NOT NULL,
  product_profile_id BIGINT UNSIGNED NULL,
  product_key        VARCHAR(100) NULL,
  preference_status  ENUM('unknown','interested','not_interested','maybe_later','requested_info','rejected_offer','customer') NOT NULL DEFAULT 'unknown',
  source             ENUM('manual','reply','outreach_event','import') NOT NULL DEFAULT 'manual',
  note               VARCHAR(1000) NULL,
  last_interaction_at TIMESTAMP NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_cpp (contact_point_id, product_key),
  KEY idx_cpp_company (company_id),
  KEY idx_cpp_product (product_key),
  KEY idx_cpp_status (preference_status),
  CONSTRAINT fk_cpp_contact  FOREIGN KEY (contact_point_id) REFERENCES contact_points(id) ON DELETE CASCADE,
  CONSTRAINT fk_cpp_company  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT fk_cpp_profile  FOREIGN KEY (product_profile_id) REFERENCES tenant_product_profiles(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 9. contact_topic_preferences
CREATE TABLE IF NOT EXISTS contact_topic_preferences (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  contact_point_id  BIGINT UNSIGNED NOT NULL,
  industry_id       BIGINT UNSIGNED NULL,
  topic_slug        VARCHAR(80) NOT NULL,
  preference_status ENUM('unknown','interested','not_interested','maybe_later') NOT NULL DEFAULT 'unknown',
  source            VARCHAR(40) NOT NULL DEFAULT 'manual',
  note              VARCHAR(500) NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ctp (contact_point_id, topic_slug),
  KEY idx_ctp_industry (industry_id),
  CONSTRAINT fk_ctp_contact  FOREIGN KEY (contact_point_id) REFERENCES contact_points(id) ON DELETE CASCADE,
  CONSTRAINT fk_ctp_industry FOREIGN KEY (industry_id) REFERENCES industry_taxonomy(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 10. global_contact_suppression (cross-tenant)
CREATE TABLE IF NOT EXISTS global_contact_suppression (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  type                 ENUM('email','domain','phone') NOT NULL,
  normalized_value     VARCHAR(500) NOT NULL,
  reason               ENUM('unsubscribe','complaint','hard_bounce','do_not_contact','legal_request','abuse','manual') NOT NULL DEFAULT 'manual',
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by_user_id   BIGINT UNSIGNED NULL,
  source               VARCHAR(200) NULL,
  metadata_json        JSON NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_gcs (type, normalized_value(300)),
  KEY idx_gcs_type (type),
  CONSTRAINT fk_gcs_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 11. tenant_contact_notes
CREATE TABLE IF NOT EXISTS tenant_contact_notes (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id           BIGINT UNSIGNED NOT NULL,
  company_id          BIGINT UNSIGNED NOT NULL,
  contact_point_id    BIGINT UNSIGNED NULL,
  note                TEXT NOT NULL,
  status              VARCHAR(60) NULL,
  created_by_user_id  BIGINT UNSIGNED NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_tcn_tenant_co (tenant_id, company_id),
  KEY idx_tcn_contact (contact_point_id),
  CONSTRAINT fk_tcn_tenant  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_tcn_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  CONSTRAINT fk_tcn_contact FOREIGN KEY (contact_point_id) REFERENCES contact_points(id) ON DELETE SET NULL,
  CONSTRAINT fk_tcn_user    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 12. lead_warehouse_events
CREATE TABLE IF NOT EXISTS lead_warehouse_events (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id         BIGINT UNSIGNED NULL,
  company_id        BIGINT UNSIGNED NULL,
  contact_point_id  BIGINT UNSIGNED NULL,
  event_type        VARCHAR(80) NOT NULL,
  metadata_json     JSON NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_lwe_tenant_time (tenant_id, created_at),
  KEY idx_lwe_company (company_id),
  KEY idx_lwe_contact (contact_point_id),
  KEY idx_lwe_type (event_type),
  CONSTRAINT fk_lwe_tenant  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL,
  CONSTRAINT fk_lwe_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL,
  CONSTRAINT fk_lwe_contact FOREIGN KEY (contact_point_id) REFERENCES contact_points(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ================================================================
-- SEED: industry_taxonomy
-- INSERT IGNORE so idempotent on re-run
-- ================================================================

-- Root categories
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id) VALUES
  ('beauty',            'Beauty & Personal Care', 'Красота и уход', 'Краса та догляд', NULL),
  ('medical',           'Medical & Health',       'Медицина и здоровье', 'Медицина та здоров\'я', NULL),
  ('local_services',    'Local Services',         'Местные услуги', 'Місцеві послуги', NULL),
  ('digital',           'Digital & Tech',         'Цифровые и технологии', 'Цифрові та технології', NULL),
  ('food_hospitality',  'Food & Hospitality',     'Еда и гостеприимство', 'Їжа та гостинність', NULL),
  ('education',         'Education & Training',   'Образование и обучение', 'Освіта та навчання', NULL);

-- Beauty sub-categories
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'beauty_salon',    'Beauty Salon',  'Салон красоты',  'Салон краси',  id FROM industry_taxonomy WHERE slug='beauty';
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'nail_studio',     'Nail Studio',   'Ногтевая студия','Нейл-студія',  id FROM industry_taxonomy WHERE slug='beauty';
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'barbershop',      'Barbershop',    'Барбершоп',      'Барбершоп',    id FROM industry_taxonomy WHERE slug='beauty';
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'spa',             'Spa',           'Спа',            'Спа',          id FROM industry_taxonomy WHERE slug='beauty';
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'massage',         'Massage',       'Массаж',         'Масаж',        id FROM industry_taxonomy WHERE slug='beauty';

-- Medical sub-categories
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'dental_clinic',   'Dental Clinic',    'Стоматология',      'Стоматологія',      id FROM industry_taxonomy WHERE slug='medical';
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'private_clinic',  'Private Clinic',   'Частная клиника',   'Приватна клініка',  id FROM industry_taxonomy WHERE slug='medical';
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'dermatology',     'Dermatology',      'Дерматология',      'Дерматологія',      id FROM industry_taxonomy WHERE slug='medical';
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'veterinary_clinic','Veterinary Clinic','Ветеринарная клиника','Ветеринарна клініка', id FROM industry_taxonomy WHERE slug='medical';

-- Local Services sub-categories
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'repair_service',  'Repair Service',  'Ремонтный сервис', 'Ремонтний сервіс', id FROM industry_taxonomy WHERE slug='local_services';
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'cleaning_service','Cleaning Service','Клининг',          'Клінінг',          id FROM industry_taxonomy WHERE slug='local_services';
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'car_service',     'Car Service',     'Автосервис',       'Автосервіс',       id FROM industry_taxonomy WHERE slug='local_services';
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'legal_service',   'Legal Service',   'Юридические услуги','Юридичні послуги', id FROM industry_taxonomy WHERE slug='local_services';
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'real_estate',     'Real Estate',     'Недвижимость',     'Нерухомість',      id FROM industry_taxonomy WHERE slug='local_services';

-- Digital sub-categories
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'web_agency',      'Web Agency',        'Веб-агентство',   'Веб-агентство',   id FROM industry_taxonomy WHERE slug='digital';
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'marketing_agency','Marketing Agency',  'Маркетинговое агентство','Маркетингова агенція', id FROM industry_taxonomy WHERE slug='digital';
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'saas',            'SaaS',              'SaaS',            'SaaS',            id FROM industry_taxonomy WHERE slug='digital';
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'ecommerce',       'E-commerce',        'Интернет-магазин','Інтернет-магазин', id FROM industry_taxonomy WHERE slug='digital';
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'wordpress_site',  'WordPress Site',    'WordPress-сайт',  'WordPress-сайт',  id FROM industry_taxonomy WHERE slug='digital';
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'shopify_store',   'Shopify Store',     'Shopify-магазин', 'Shopify-магазин', id FROM industry_taxonomy WHERE slug='digital';
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'woocommerce_store','WooCommerce Store', 'WooCommerce-магазин','WooCommerce-магазин', id FROM industry_taxonomy WHERE slug='digital';

-- Food & Hospitality sub-categories
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'restaurant',      'Restaurant',    'Ресторан',      'Ресторан',      id FROM industry_taxonomy WHERE slug='food_hospitality';
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'cafe',            'Cafe',          'Кафе',          'Кафе',          id FROM industry_taxonomy WHERE slug='food_hospitality';
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'hotel',           'Hotel',         'Отель',         'Готель',        id FROM industry_taxonomy WHERE slug='food_hospitality';
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'travel_agency',   'Travel Agency', 'Тур.агентство', 'Тур.агентство', id FROM industry_taxonomy WHERE slug='food_hospitality';

-- Education sub-categories
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'courses',         'Online Courses','Онлайн-курсы',  'Онлайн-курси',  id FROM industry_taxonomy WHERE slug='education';
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'tutoring',        'Tutoring',      'Репетиторство', 'Репетиторство', id FROM industry_taxonomy WHERE slug='education';
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'school',          'School',        'Школа',         'Школа',         id FROM industry_taxonomy WHERE slug='education';
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'training_center', 'Training Center','Учебный центр','Навчальний центр',id FROM industry_taxonomy WHERE slug='education';
