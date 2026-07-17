-- Phase 12.1: Extended industry taxonomy for legacy Google Maps import
-- Adds: fitness, professional_services roots + 12 new local_services children

-- New root categories
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
VALUES
  ('fitness',               'Fitness & Sports',         'Фитнес и спорт',             'Фітнес та спорт',            NULL),
  ('professional_services', 'Professional Services',    'Профессиональные услуги',     'Професійні послуги',         NULL);

-- local_services children (slugs from legacy CSV)
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'electricians', 'Electricians', 'Электрики', 'Електрики', id FROM industry_taxonomy WHERE slug='local_services' LIMIT 1;

INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'plumbers', 'Plumbers', 'Сантехники', 'Сантехніки', id FROM industry_taxonomy WHERE slug='local_services' LIMIT 1;

INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'hvac', 'HVAC Services', 'HVAC-услуги', 'HVAC-послуги', id FROM industry_taxonomy WHERE slug='local_services' LIMIT 1;

INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'roofing', 'Roofing', 'Кровельные работы', 'Покрівельні роботи', id FROM industry_taxonomy WHERE slug='local_services' LIMIT 1;

INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'pest_control', 'Pest Control', 'Дезинсекция', 'Дезінсекція', id FROM industry_taxonomy WHERE slug='local_services' LIMIT 1;

INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'locksmiths', 'Locksmiths', 'Замочники', 'Слюсарі', id FROM industry_taxonomy WHERE slug='local_services' LIMIT 1;

INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'landscaping', 'Landscaping', 'Ландшафтный дизайн', 'Ландшафтний дизайн', id FROM industry_taxonomy WHERE slug='local_services' LIMIT 1;

INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'auto_repair', 'Auto Repair', 'Автосервис', 'Автосервіс', id FROM industry_taxonomy WHERE slug='local_services' LIMIT 1;

INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'cleaning', 'Cleaning Services', 'Клининг', 'Клінінг', id FROM industry_taxonomy WHERE slug='local_services' LIMIT 1;

INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'legal', 'Legal Services', 'Юридические услуги', 'Юридичні послуги', id FROM industry_taxonomy WHERE slug='local_services' LIMIT 1;

-- fitness children
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'fitness_studio', 'Fitness Studio', 'Фитнес-студия', 'Фітнес-студія', id FROM industry_taxonomy WHERE slug='fitness' LIMIT 1;

-- professional_services children
INSERT IGNORE INTO industry_taxonomy (slug, name_en, name_ru, name_uk, parent_id)
SELECT 'accountants', 'Accountants', 'Бухгалтеры', 'Бухгалтери', id FROM industry_taxonomy WHERE slug='professional_services' LIMIT 1;
