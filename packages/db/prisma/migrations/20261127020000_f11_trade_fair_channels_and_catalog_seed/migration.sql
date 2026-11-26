-- F11: Seed channel_catalog and 20 trade fair manifests for missing entries.
-- Preserve existing operator state and provenance. Only the verified ProPak
-- adapter is eligible for default enablement under its current source policy.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

INSERT INTO "data_provider" ("id", "key", "class", "status", "cost_per_call_cents")
VALUES (gen_random_uuid(), 'channel_catalog', 'industry_data', 'ENABLED', 0)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "source_policy" (
  "id", "domain", "source_type", "access_mode", "robots_status", "terms_status",
  "personal_data", "allowed_purpose", "crawl_delay_ms", "retention_days",
  "review_status", "owner", "notes", "updated_at"
)
VALUES (
  gen_random_uuid(), 'propakasia.com', 'trade_fair', 'crawl', 'ALLOWS', 'REVIEWED_OK',
  false, '["discovery"]'::jsonb, 2000, 365,
  'APPROVED', 'backend', 'ProPak Asia 2026 exhibitor directory (F11 seed)', now()
)
ON CONFLICT ("domain") DO NOTHING;

-- intersolar-europe (DISABLED)
INSERT INTO "source_channel" (
  "id", "name", "mode", "category", "status", "config",
  "manifest", "manifest_sha256", "manifest_version", "connector_kind",
  "base_url", "rate_limit", "pagination", "probe_required",
  "license", "tos_url", "robots_policy", "disabled_reason", "updated_at"
)
SELECT
  gen_random_uuid(), 'Intersolar Europe', 'crawl', 'trade_fair', 'DISABLED', '{"detail":{"enabled":false,"fields":{}},"list":{"itemSelector":".exhibitor-item","maxPages":1,"singlePage":true,"url":"https://www.intersolar.de/exhibitor-list"},"mode":"crawl"}'::jsonb,
  '{"auth":{"type":"none"},"crawl":{"detail":{"enabled":false},"list":{"itemSelector":".exhibitor-item","maxPages":1,"url":"https://www.intersolar.de/exhibitor-list"}},"meta":{"category":"trade_fair","description":"全球最大欧洲光伏展（慕尼黑），覆盖德国/意大利/西班牙/荷兰/波兰 EPC 与分销商","docsUrl":"https://www.intersolar.de/exhibitor-list","name":"Intersolar Europe","version":1},"pagination":{"type":"none"},"rateLimit":{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5},"transport":{"allowedHosts":["www.intersolar.de"],"baseUrl":"https://www.intersolar.de","maxResponseBytes":5242880,"method":"GET","responseType":"html","timeoutMs":15000}}'::jsonb, '210dc490f059da1bda87070647fa3babb65050dca00a5ada34845fff19698a66', 'channel-manifest/v1', 'manifest',
  'https://www.intersolar.de', '{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5}'::jsonb, '{"type":"none"}'::jsonb, true,
  NULL, NULL, NULL, 'OPERATOR', now()
WHERE NOT EXISTS (SELECT 1 FROM "source_channel" WHERE "name" = 'Intersolar Europe');

-- key-energy-rimini (DISABLED)
INSERT INTO "source_channel" (
  "id", "name", "mode", "category", "status", "config",
  "manifest", "manifest_sha256", "manifest_version", "connector_kind",
  "base_url", "rate_limit", "pagination", "probe_required",
  "license", "tos_url", "robots_policy", "disabled_reason", "updated_at"
)
SELECT
  gen_random_uuid(), 'KEY - The Energy Transition Expo (Rimini)', 'crawl', 'trade_fair', 'DISABLED', '{"detail":{"enabled":false,"fields":{}},"list":{"itemSelector":".exhibitor-item","maxPages":1,"singlePage":true,"url":"https://www.key-expo.com/exhibitors-catalogue"},"mode":"crawl"}'::jsonb,
  '{"auth":{"type":"none"},"crawl":{"detail":{"enabled":false},"list":{"itemSelector":".exhibitor-item","maxPages":1,"url":"https://www.key-expo.com/exhibitors-catalogue"}},"meta":{"category":"trade_fair","description":"意大利里米尼能源转型与光伏旗舰展，高密度意大利/南欧工商业 EPC 与批发商","docsUrl":"https://www.key-expo.com/exhibitors-catalogue","name":"KEY - The Energy Transition Expo (Rimini)","version":1},"pagination":{"type":"none"},"rateLimit":{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5},"transport":{"allowedHosts":["www.key-expo.com"],"baseUrl":"https://www.key-expo.com","maxResponseBytes":5242880,"method":"GET","responseType":"html","timeoutMs":15000}}'::jsonb, 'd7731794a500a86467324e654f1b968d198e9e89f600b07b0b1b3c692f8a4048', 'channel-manifest/v1', 'manifest',
  'https://www.key-expo.com', '{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5}'::jsonb, '{"type":"none"}'::jsonb, true,
  NULL, NULL, NULL, 'OPERATOR', now()
WHERE NOT EXISTS (SELECT 1 FROM "source_channel" WHERE "name" = 'KEY - The Energy Transition Expo (Rimini)');

-- re-plus-north-america (DISABLED)
INSERT INTO "source_channel" (
  "id", "name", "mode", "category", "status", "config",
  "manifest", "manifest_sha256", "manifest_version", "connector_kind",
  "base_url", "rate_limit", "pagination", "probe_required",
  "license", "tos_url", "robots_policy", "disabled_reason", "updated_at"
)
SELECT
  gen_random_uuid(), 'RE+ (SPI & ESI North America)', 'crawl', 'trade_fair', 'DISABLED', '{"detail":{"enabled":false,"fields":{}},"list":{"itemSelector":".exhibitor-item","maxPages":1,"singlePage":true,"url":"https://www.re-plus.com/exhibitor-list/"},"mode":"crawl"}'::jsonb,
  '{"auth":{"type":"none"},"crawl":{"detail":{"enabled":false},"list":{"itemSelector":".exhibitor-item","maxPages":1,"url":"https://www.re-plus.com/exhibitor-list/"}},"meta":{"category":"trade_fair","description":"北美最大清洁能源展，覆盖美国/加拿大/墨西哥工商业与地面电站开发商及分销商","docsUrl":"https://www.re-plus.com/exhibitor-list/","name":"RE+ (SPI & ESI North America)","version":1},"pagination":{"type":"none"},"rateLimit":{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5},"transport":{"allowedHosts":["www.re-plus.com"],"baseUrl":"https://www.re-plus.com","maxResponseBytes":5242880,"method":"GET","responseType":"html","timeoutMs":15000}}'::jsonb, '43bdb47412a70a00ec4fc8fcded6e4d17b48a96861bebad6ec557e9d89847314', 'channel-manifest/v1', 'manifest',
  'https://www.re-plus.com', '{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5}'::jsonb, '{"type":"none"}'::jsonb, true,
  NULL, NULL, NULL, 'OPERATOR', now()
WHERE NOT EXISTS (SELECT 1 FROM "source_channel" WHERE "name" = 'RE+ (SPI & ESI North America)');

-- intersolar-south-america (DISABLED)
INSERT INTO "source_channel" (
  "id", "name", "mode", "category", "status", "config",
  "manifest", "manifest_sha256", "manifest_version", "connector_kind",
  "base_url", "rate_limit", "pagination", "probe_required",
  "license", "tos_url", "robots_policy", "disabled_reason", "updated_at"
)
SELECT
  gen_random_uuid(), 'Intersolar South America', 'crawl', 'trade_fair', 'DISABLED', '{"detail":{"enabled":false,"fields":{}},"list":{"itemSelector":".exhibitor-item","maxPages":1,"singlePage":true,"url":"https://www.intersolar.net.br/exhibitor-list"},"mode":"crawl"}'::jsonb,
  '{"auth":{"type":"none"},"crawl":{"detail":{"enabled":false},"list":{"itemSelector":".exhibitor-item","maxPages":1,"url":"https://www.intersolar.net.br/exhibitor-list"}},"meta":{"category":"trade_fair","description":"拉美最大光伏展（圣保罗），覆盖巴西/智利/哥伦比亚/墨西哥分布式光伏分销商与集成商","docsUrl":"https://www.intersolar.net.br/exhibitor-list","name":"Intersolar South America","version":1},"pagination":{"type":"none"},"rateLimit":{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5},"transport":{"allowedHosts":["www.intersolar.net.br"],"baseUrl":"https://www.intersolar.net.br","maxResponseBytes":5242880,"method":"GET","responseType":"html","timeoutMs":15000}}'::jsonb, '20f24b5dae9381c9a29ff6e9e8039dd8c8fe4b41ca4001b8fd84c89bbf172165', 'channel-manifest/v1', 'manifest',
  'https://www.intersolar.net.br', '{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5}'::jsonb, '{"type":"none"}'::jsonb, true,
  NULL, NULL, NULL, 'OPERATOR', now()
WHERE NOT EXISTS (SELECT 1 FROM "source_channel" WHERE "name" = 'Intersolar South America');

-- autopromotec-bologna (DISABLED)
INSERT INTO "source_channel" (
  "id", "name", "mode", "category", "status", "config",
  "manifest", "manifest_sha256", "manifest_version", "connector_kind",
  "base_url", "rate_limit", "pagination", "probe_required",
  "license", "tos_url", "robots_policy", "disabled_reason", "updated_at"
)
SELECT
  gen_random_uuid(), 'Autopromotec Bologna', 'crawl', 'trade_fair', 'DISABLED', '{"detail":{"enabled":false,"fields":{}},"list":{"itemSelector":".exhibitor-item","maxPages":1,"singlePage":true,"url":"https://www.autopromotec.com/en/catalogo/index.php?S=CAT_INDEX"},"mode":"crawl"}'::jsonb,
  '{"auth":{"type":"none"},"crawl":{"detail":{"enabled":false},"list":{"itemSelector":".exhibitor-item","maxPages":1,"url":"https://www.autopromotec.com/en/catalogo/index.php?S=CAT_INDEX"}},"meta":{"category":"trade_fair","description":"自研 PHP 目录，需提交筛选取结果","docsUrl":"https://www.autopromotec.com/en/catalogo/index.php?S=CAT_INDEX","name":"Autopromotec Bologna","version":1},"pagination":{"type":"none"},"rateLimit":{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5},"transport":{"allowedHosts":["www.autopromotec.com"],"baseUrl":"https://www.autopromotec.com","maxResponseBytes":5242880,"method":"GET","responseType":"html","timeoutMs":15000}}'::jsonb, 'b010ba8e5c788fe5c3381bc003c9d02577c1c508e6899b535839d362ed450ae7', 'channel-manifest/v1', 'manifest',
  'https://www.autopromotec.com', '{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5}'::jsonb, '{"type":"none"}'::jsonb, true,
  NULL, NULL, NULL, 'OPERATOR', now()
WHERE NOT EXISTS (SELECT 1 FROM "source_channel" WHERE "name" = 'Autopromotec Bologna');

-- cfia-rennes-2027 (DISABLED)
INSERT INTO "source_channel" (
  "id", "name", "mode", "category", "status", "config",
  "manifest", "manifest_sha256", "manifest_version", "connector_kind",
  "base_url", "rate_limit", "pagination", "probe_required",
  "license", "tos_url", "robots_policy", "disabled_reason", "updated_at"
)
SELECT
  gen_random_uuid(), 'CFIA Rennes 2027', 'crawl', 'trade_fair', 'DISABLED', '{"detail":{"enabled":false,"fields":{}},"list":{"itemSelector":".exhibitor-item","maxPages":1,"singlePage":true,"url":"https://rennes.cfiaexpo.com/en/exhibitors-list"},"mode":"crawl"}'::jsonb,
  '{"auth":{"type":"none"},"crawl":{"detail":{"enabled":false},"list":{"itemSelector":".exhibitor-item","maxPages":1,"url":"https://rennes.cfiaexpo.com/en/exhibitors-list"}},"meta":{"category":"trade_fair","description":"GL Events SPA","docsUrl":"https://rennes.cfiaexpo.com/en/exhibitors-list","name":"CFIA Rennes 2027","version":1},"pagination":{"type":"none"},"rateLimit":{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5},"transport":{"allowedHosts":["rennes.cfiaexpo.com"],"baseUrl":"https://rennes.cfiaexpo.com","maxResponseBytes":5242880,"method":"GET","responseType":"html","timeoutMs":15000}}'::jsonb, '667d3ed65355c0f2bdaabeaa3d3067605a19e6a78001c97d5680424b2586cae9', 'channel-manifest/v1', 'manifest',
  'https://rennes.cfiaexpo.com', '{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5}'::jsonb, '{"type":"none"}'::jsonb, true,
  NULL, NULL, NULL, 'OPERATOR', now()
WHERE NOT EXISTS (SELECT 1 FROM "source_channel" WHERE "name" = 'CFIA Rennes 2027');

-- chinaplas-2027 (DISABLED)
INSERT INTO "source_channel" (
  "id", "name", "mode", "category", "status", "config",
  "manifest", "manifest_sha256", "manifest_version", "connector_kind",
  "base_url", "rate_limit", "pagination", "probe_required",
  "license", "tos_url", "robots_policy", "disabled_reason", "updated_at"
)
SELECT
  gen_random_uuid(), 'CHINAPLAS 2027', 'crawl', 'trade_fair', 'DISABLED', '{"detail":{"enabled":false,"fields":{}},"list":{"itemSelector":".exhibitor-item","maxPages":1,"singlePage":true,"url":"https://www.chinaplasonline.com/cps/exhibitor/list/eng"},"mode":"crawl"}'::jsonb,
  '{"auth":{"type":"none"},"crawl":{"detail":{"enabled":false},"list":{"itemSelector":".exhibitor-item","maxPages":1,"url":"https://www.chinaplasonline.com/cps/exhibitor/list/eng"}},"meta":{"category":"trade_fair","description":"Adsale SPA，需 headless 或后端 JSON","docsUrl":"https://www.chinaplasonline.com/cps/exhibitor/list/eng","name":"CHINAPLAS 2027","version":1},"pagination":{"type":"none"},"rateLimit":{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5},"transport":{"allowedHosts":["www.chinaplasonline.com"],"baseUrl":"https://www.chinaplasonline.com","maxResponseBytes":5242880,"method":"GET","responseType":"html","timeoutMs":15000}}'::jsonb, 'be8caf21a62ef00c74f38742af42db732ef5cac0173c5cabdc60bcbc46ef20cd', 'channel-manifest/v1', 'manifest',
  'https://www.chinaplasonline.com', '{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5}'::jsonb, '{"type":"none"}'::jsonb, true,
  NULL, NULL, NULL, 'OPERATOR', now()
WHERE NOT EXISTS (SELECT 1 FROM "source_channel" WHERE "name" = 'CHINAPLAS 2027');

-- expomed-eurasia (DISABLED)
INSERT INTO "source_channel" (
  "id", "name", "mode", "category", "status", "config",
  "manifest", "manifest_sha256", "manifest_version", "connector_kind",
  "base_url", "rate_limit", "pagination", "probe_required",
  "license", "tos_url", "robots_policy", "disabled_reason", "updated_at"
)
SELECT
  gen_random_uuid(), 'Expomed Eurasia', 'crawl', 'trade_fair', 'DISABLED', '{"detail":{"enabled":false,"fields":{}},"list":{"itemSelector":".exhibitor-item","maxPages":1,"singlePage":true,"url":"https://expomedistanbul.com/en/exhibitor-list"},"mode":"crawl"}'::jsonb,
  '{"auth":{"type":"none"},"crawl":{"detail":{"enabled":false},"list":{"itemSelector":".exhibitor-item","maxPages":1,"url":"https://expomedistanbul.com/en/exhibitor-list"}},"meta":{"category":"trade_fair","description":"分页服务端渲染，47 页","docsUrl":"https://expomedistanbul.com/en/exhibitor-list","name":"Expomed Eurasia","version":1},"pagination":{"type":"none"},"rateLimit":{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5},"transport":{"allowedHosts":["expomedistanbul.com"],"baseUrl":"https://expomedistanbul.com","maxResponseBytes":5242880,"method":"GET","responseType":"html","timeoutMs":15000}}'::jsonb, 'a251780f67f0af7df733023b11ec1b22576fed7b492d13e13997837be2fc9cc1', 'channel-manifest/v1', 'manifest',
  'https://expomedistanbul.com', '{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5}'::jsonb, '{"type":"none"}'::jsonb, true,
  NULL, NULL, NULL, 'OPERATOR', now()
WHERE NOT EXISTS (SELECT 1 FROM "source_channel" WHERE "name" = 'Expomed Eurasia');

-- fespa-brasil-2027 (DISABLED)
INSERT INTO "source_channel" (
  "id", "name", "mode", "category", "status", "config",
  "manifest", "manifest_sha256", "manifest_version", "connector_kind",
  "base_url", "rate_limit", "pagination", "probe_required",
  "license", "tos_url", "robots_policy", "disabled_reason", "updated_at"
)
SELECT
  gen_random_uuid(), 'FESPA Brasil 2027', 'crawl', 'trade_fair', 'DISABLED', '{"detail":{"enabled":false,"fields":{}},"list":{"itemSelector":".exhibitor-item","maxPages":1,"singlePage":true,"url":"https://www.fespabrasil.com.br/en/evento/empresas"},"mode":"crawl"}'::jsonb,
  '{"auth":{"type":"none"},"crawl":{"detail":{"enabled":false},"list":{"itemSelector":".exhibitor-item","maxPages":1,"url":"https://www.fespabrasil.com.br/en/evento/empresas"}},"meta":{"category":"trade_fair","description":"静态 A-Z 300+ 家（名字+展馆+展位+官网）","docsUrl":"https://www.fespabrasil.com.br/en/evento/empresas","name":"FESPA Brasil 2027","version":1},"pagination":{"type":"none"},"rateLimit":{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5},"transport":{"allowedHosts":["www.fespabrasil.com.br"],"baseUrl":"https://www.fespabrasil.com.br","maxResponseBytes":5242880,"method":"GET","responseType":"html","timeoutMs":15000}}'::jsonb, '107b4d27c2e3148173ef5c9252c6394dbdef48703776f3cd1d5a8a8e92b6b768', 'channel-manifest/v1', 'manifest',
  'https://www.fespabrasil.com.br', '{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5}'::jsonb, '{"type":"none"}'::jsonb, true,
  NULL, NULL, NULL, 'OPERATOR', now()
WHERE NOT EXISTS (SELECT 1 FROM "source_channel" WHERE "name" = 'FESPA Brasil 2027');

-- gulfood-manufacturing-2026 (DISABLED)
INSERT INTO "source_channel" (
  "id", "name", "mode", "category", "status", "config",
  "manifest", "manifest_sha256", "manifest_version", "connector_kind",
  "base_url", "rate_limit", "pagination", "probe_required",
  "license", "tos_url", "robots_policy", "disabled_reason", "updated_at"
)
SELECT
  gen_random_uuid(), 'Gulfood Manufacturing 2026', 'crawl', 'trade_fair', 'DISABLED', '{"detail":{"enabled":false,"fields":{}},"list":{"itemSelector":".exhibitor-item","maxPages":1,"singlePage":true,"url":"https://exhibitors.gulfoodmanufacturing.com/gulfood-manufacturing-2026/Exhibitor"},"mode":"crawl"}'::jsonb,
  '{"auth":{"type":"none"},"crawl":{"detail":{"enabled":false},"list":{"itemSelector":".exhibitor-item","maxPages":1,"url":"https://exhibitors.gulfoodmanufacturing.com/gulfood-manufacturing-2026/Exhibitor"}},"meta":{"category":"trade_fair","description":"Xporience/Informa SPA","docsUrl":"https://exhibitors.gulfoodmanufacturing.com/gulfood-manufacturing-2026/Exhibitor","name":"Gulfood Manufacturing 2026","version":1},"pagination":{"type":"none"},"rateLimit":{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5},"transport":{"allowedHosts":["exhibitors.gulfoodmanufacturing.com"],"baseUrl":"https://exhibitors.gulfoodmanufacturing.com","maxResponseBytes":5242880,"method":"GET","responseType":"html","timeoutMs":15000}}'::jsonb, '8281d1bd08d3951359aa6b9ab0089c933c9059777454b9d922feac3cc9561061', 'channel-manifest/v1', 'manifest',
  'https://exhibitors.gulfoodmanufacturing.com', '{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5}'::jsonb, '{"type":"none"}'::jsonb, true,
  NULL, NULL, NULL, 'OPERATOR', now()
WHERE NOT EXISTS (SELECT 1 FROM "source_channel" WHERE "name" = 'Gulfood Manufacturing 2026');

-- gulf-print-pack-2026 (DISABLED)
INSERT INTO "source_channel" (
  "id", "name", "mode", "category", "status", "config",
  "manifest", "manifest_sha256", "manifest_version", "connector_kind",
  "base_url", "rate_limit", "pagination", "probe_required",
  "license", "tos_url", "robots_policy", "disabled_reason", "updated_at"
)
SELECT
  gen_random_uuid(), 'Gulf Print & Pack 2026', 'crawl', 'trade_fair', 'DISABLED', '{"detail":{"enabled":false,"fields":{}},"list":{"itemSelector":".exhibitor-item","maxPages":1,"singlePage":true,"url":"https://www.gulfprintpack.com/exhibitor-list"},"mode":"crawl"}'::jsonb,
  '{"auth":{"type":"none"},"crawl":{"detail":{"enabled":false},"list":{"itemSelector":".exhibitor-item","maxPages":1,"url":"https://www.gulfprintpack.com/exhibitor-list"}},"meta":{"category":"trade_fair","description":"Cloudflare 403；300+ 家（通过 L0 搜索引擎查公开参展索引）","docsUrl":"https://www.gulfprintpack.com/exhibitor-list","name":"Gulf Print & Pack 2026","version":1},"pagination":{"type":"none"},"rateLimit":{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5},"transport":{"allowedHosts":["www.gulfprintpack.com"],"baseUrl":"https://www.gulfprintpack.com","maxResponseBytes":5242880,"method":"GET","responseType":"html","timeoutMs":15000}}'::jsonb, '86eb7d1ab640debead7679d7ebdb3fa9c7eff653f50b70e080c9e6fd528a83c8', 'channel-manifest/v1', 'manifest',
  'https://www.gulfprintpack.com', '{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5}'::jsonb, '{"type":"none"}'::jsonb, true,
  NULL, NULL, NULL, 'GOVERNANCE', now()
WHERE NOT EXISTS (SELECT 1 FROM "source_channel" WHERE "name" = 'Gulf Print & Pack 2026');

-- intersec-dubai-2026 (DISABLED)
INSERT INTO "source_channel" (
  "id", "name", "mode", "category", "status", "config",
  "manifest", "manifest_sha256", "manifest_version", "connector_kind",
  "base_url", "rate_limit", "pagination", "probe_required",
  "license", "tos_url", "robots_policy", "disabled_reason", "updated_at"
)
SELECT
  gen_random_uuid(), 'Intersec Dubai 2026', 'crawl', 'trade_fair', 'DISABLED', '{"detail":{"enabled":false,"fields":{}},"list":{"itemSelector":".exhibitor-item","maxPages":1,"singlePage":true,"url":"https://intersecglobal.ae.messefrankfurt.com/dubai/en/exhibitor-search.html"},"mode":"crawl"}'::jsonb,
  '{"auth":{"type":"none"},"crawl":{"detail":{"enabled":false},"list":{"itemSelector":".exhibitor-item","maxPages":1,"url":"https://intersecglobal.ae.messefrankfurt.com/dubai/en/exhibitor-search.html"}},"meta":{"category":"trade_fair","description":"Messe Frankfurt 自研搜索 SPA","docsUrl":"https://intersecglobal.ae.messefrankfurt.com/dubai/en/exhibitor-search.html","name":"Intersec Dubai 2026","version":1},"pagination":{"type":"none"},"rateLimit":{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5},"transport":{"allowedHosts":["intersecglobal.ae.messefrankfurt.com"],"baseUrl":"https://intersecglobal.ae.messefrankfurt.com","maxResponseBytes":5242880,"method":"GET","responseType":"html","timeoutMs":15000}}'::jsonb, 'adf8ca9fd2e0c2b5acfb436a12af42e85a6c8a68b1d86e1085591c3b323236d5', 'channel-manifest/v1', 'manifest',
  'https://intersecglobal.ae.messefrankfurt.com', '{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5}'::jsonb, '{"type":"none"}'::jsonb, true,
  NULL, NULL, NULL, 'OPERATOR', now()
WHERE NOT EXISTS (SELECT 1 FROM "source_channel" WHERE "name" = 'Intersec Dubai 2026');

-- loupe-americas-2026 (DISABLED)
INSERT INTO "source_channel" (
  "id", "name", "mode", "category", "status", "config",
  "manifest", "manifest_sha256", "manifest_version", "connector_kind",
  "base_url", "rate_limit", "pagination", "probe_required",
  "license", "tos_url", "robots_policy", "disabled_reason", "updated_at"
)
SELECT
  gen_random_uuid(), 'LOUPE Americas 2026 (ex-Labelexpo)', 'crawl', 'trade_fair', 'DISABLED', '{"detail":{"enabled":false,"fields":{}},"list":{"itemSelector":".exhibitor-item","maxPages":1,"singlePage":true,"url":"https://www.loupe-americas.com/exhibitor-list"},"mode":"crawl"}'::jsonb,
  '{"auth":{"type":"none"},"crawl":{"detail":{"enabled":false},"list":{"itemSelector":".exhibitor-item","maxPages":1,"url":"https://www.loupe-americas.com/exhibitor-list"}},"meta":{"category":"trade_fair","description":"Cloudflare 403；450+ 家（通过 L0 搜索引擎查公开参展索引）","docsUrl":"https://www.loupe-americas.com/exhibitor-list","name":"LOUPE Americas 2026 (ex-Labelexpo)","version":1},"pagination":{"type":"none"},"rateLimit":{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5},"transport":{"allowedHosts":["www.loupe-americas.com"],"baseUrl":"https://www.loupe-americas.com","maxResponseBytes":5242880,"method":"GET","responseType":"html","timeoutMs":15000}}'::jsonb, '32ff509f591632fde0940b3f654e4e2b9a190ff3d214b1e387a1a9dd1e8d3454', 'channel-manifest/v1', 'manifest',
  'https://www.loupe-americas.com', '{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5}'::jsonb, '{"type":"none"}'::jsonb, true,
  NULL, NULL, NULL, 'GOVERNANCE', now()
WHERE NOT EXISTS (SELECT 1 FROM "source_channel" WHERE "name" = 'LOUPE Americas 2026 (ex-Labelexpo)');

-- nepcon-japan (DISABLED)
INSERT INTO "source_channel" (
  "id", "name", "mode", "category", "status", "config",
  "manifest", "manifest_sha256", "manifest_version", "connector_kind",
  "base_url", "rate_limit", "pagination", "probe_required",
  "license", "tos_url", "robots_policy", "disabled_reason", "updated_at"
)
SELECT
  gen_random_uuid(), 'NEPCON JAPAN', 'crawl', 'trade_fair', 'DISABLED', '{"detail":{"enabled":false,"fields":{}},"list":{"itemSelector":".exhibitor-item","maxPages":1,"singlePage":true,"url":"https://www.nepconjapan.jp/tokyo/en-gb/search/2026/ex-list.html"},"mode":"crawl"}'::jsonb,
  '{"auth":{"type":"none"},"crawl":{"detail":{"enabled":false},"list":{"itemSelector":".exhibitor-item","maxPages":1,"url":"https://www.nepconjapan.jp/tokyo/en-gb/search/2026/ex-list.html"}},"meta":{"category":"trade_fair","description":"RX Japan 自研站（非 Algolia），ex-list.html 静态字母列表","docsUrl":"https://www.nepconjapan.jp/tokyo/en-gb/search/2026/ex-list.html","name":"NEPCON JAPAN","version":1},"pagination":{"type":"none"},"rateLimit":{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5},"transport":{"allowedHosts":["www.nepconjapan.jp"],"baseUrl":"https://www.nepconjapan.jp","maxResponseBytes":5242880,"method":"GET","responseType":"html","timeoutMs":15000}}'::jsonb, 'a6a6aaf6aff811fa453f5b5c002f0ec4f73490a6323ff48145742200914d67ca', 'channel-manifest/v1', 'manifest',
  'https://www.nepconjapan.jp', '{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5}'::jsonb, '{"type":"none"}'::jsonb, true,
  NULL, NULL, NULL, 'OPERATOR', now()
WHERE NOT EXISTS (SELECT 1 FROM "source_channel" WHERE "name" = 'NEPCON JAPAN');

-- pharmapack-europe-2026 (DISABLED)
INSERT INTO "source_channel" (
  "id", "name", "mode", "category", "status", "config",
  "manifest", "manifest_sha256", "manifest_version", "connector_kind",
  "base_url", "rate_limit", "pagination", "probe_required",
  "license", "tos_url", "robots_policy", "disabled_reason", "updated_at"
)
SELECT
  gen_random_uuid(), 'Pharmapack Europe 2026', 'crawl', 'trade_fair', 'DISABLED', '{"detail":{"enabled":false,"fields":{}},"list":{"itemSelector":".exhibitor-item","maxPages":1,"singlePage":true,"url":"https://exhibitors.cphi.com/ppfr26/"},"mode":"crawl"}'::jsonb,
  '{"auth":{"type":"none"},"crawl":{"detail":{"enabled":false},"list":{"itemSelector":".exhibitor-item","maxPages":1,"url":"https://exhibitors.cphi.com/ppfr26/"}},"meta":{"category":"trade_fair","description":"Informa CPHI 目录平台（多展复用）","docsUrl":"https://exhibitors.cphi.com/ppfr26/","name":"Pharmapack Europe 2026","version":1},"pagination":{"type":"none"},"rateLimit":{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5},"transport":{"allowedHosts":["exhibitors.cphi.com"],"baseUrl":"https://exhibitors.cphi.com","maxResponseBytes":5242880,"method":"GET","responseType":"html","timeoutMs":15000}}'::jsonb, '38848a5d4ed0331ccdd6313a50de5b1984e1425cdf17d2b0817ae4542cd6790e', 'channel-manifest/v1', 'manifest',
  'https://exhibitors.cphi.com', '{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5}'::jsonb, '{"type":"none"}'::jsonb, true,
  NULL, NULL, NULL, 'OPERATOR', now()
WHERE NOT EXISTS (SELECT 1 FROM "source_channel" WHERE "name" = 'Pharmapack Europe 2026');

-- plast-2026 (DISABLED)
INSERT INTO "source_channel" (
  "id", "name", "mode", "category", "status", "config",
  "manifest", "manifest_sha256", "manifest_version", "connector_kind",
  "base_url", "rate_limit", "pagination", "probe_required",
  "license", "tos_url", "robots_policy", "disabled_reason", "updated_at"
)
SELECT
  gen_random_uuid(), 'PLAST 2026', 'crawl', 'trade_fair', 'DISABLED', '{"detail":{"enabled":false,"fields":{}},"list":{"itemSelector":".exhibitor-item","maxPages":1,"singlePage":true,"url":"https://plastonline.org/en/exhibitors/list-of-exhibitors/"},"mode":"crawl"}'::jsonb,
  '{"auth":{"type":"none"},"crawl":{"detail":{"enabled":false},"list":{"itemSelector":".exhibitor-item","maxPages":1,"url":"https://plastonline.org/en/exhibitors/list-of-exhibitors/"}},"meta":{"category":"trade_fair","description":"静态 A-Z 500+ 家，可走名录列表抽取","docsUrl":"https://plastonline.org/en/exhibitors/list-of-exhibitors/","name":"PLAST 2026","version":1},"pagination":{"type":"none"},"rateLimit":{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5},"transport":{"allowedHosts":["plastonline.org"],"baseUrl":"https://plastonline.org","maxResponseBytes":5242880,"method":"GET","responseType":"html","timeoutMs":15000}}'::jsonb, '2fca5f45c473103834d50c7b564c0a5e919f424c235f16ecd0f0b9d8edca0981', 'channel-manifest/v1', 'manifest',
  'https://plastonline.org', '{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5}'::jsonb, '{"type":"none"}'::jsonb, true,
  NULL, NULL, NULL, 'OPERATOR', now()
WHERE NOT EXISTS (SELECT 1 FROM "source_channel" WHERE "name" = 'PLAST 2026');

-- plastic-japan-osaka (DISABLED)
INSERT INTO "source_channel" (
  "id", "name", "mode", "category", "status", "config",
  "manifest", "manifest_sha256", "manifest_version", "connector_kind",
  "base_url", "rate_limit", "pagination", "probe_required",
  "license", "tos_url", "robots_policy", "disabled_reason", "updated_at"
)
SELECT
  gen_random_uuid(), 'PLASTIC JAPAN (Material Week) Osaka', 'crawl', 'trade_fair', 'DISABLED', '{"detail":{"enabled":false,"fields":{}},"list":{"itemSelector":".exhibitor-item","maxPages":1,"singlePage":true,"url":"https://www.material-expo.jp/osaka/en-gb/search/2026/ex-list.html"},"mode":"crawl"}'::jsonb,
  '{"auth":{"type":"none"},"crawl":{"detail":{"enabled":false},"list":{"itemSelector":".exhibitor-item","maxPages":1,"url":"https://www.material-expo.jp/osaka/en-gb/search/2026/ex-list.html"}},"meta":{"category":"trade_fair","description":"RX Japan 自研站；伞展合并名单需按展区过滤","docsUrl":"https://www.material-expo.jp/osaka/en-gb/search/2026/ex-list.html","name":"PLASTIC JAPAN (Material Week) Osaka","version":1},"pagination":{"type":"none"},"rateLimit":{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5},"transport":{"allowedHosts":["www.material-expo.jp"],"baseUrl":"https://www.material-expo.jp","maxResponseBytes":5242880,"method":"GET","responseType":"html","timeoutMs":15000}}'::jsonb, '0b012a681d8e0cbf9f17dd023c50326bf35dc53d4d669d5c84d0cb11568f51fd', 'channel-manifest/v1', 'manifest',
  'https://www.material-expo.jp', '{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5}'::jsonb, '{"type":"none"}'::jsonb, true,
  NULL, NULL, NULL, 'OPERATOR', now()
WHERE NOT EXISTS (SELECT 1 FROM "source_channel" WHERE "name" = 'PLASTIC JAPAN (Material Week) Osaka');

-- propak-asia-2026 (eligible for ENABLED)
WITH source_approval AS (
  SELECT EXISTS (
    SELECT 1 FROM "source_policy"
    WHERE "domain" = 'propakasia.com'
      AND "source_type" = 'trade_fair' AND "access_mode" = 'crawl'
      AND "review_status" = 'APPROVED' AND "terms_status" = 'REVIEWED_OK'
      AND "robots_status" = 'ALLOWS' AND NOT "personal_data"
      AND "allowed_purpose" @> '["discovery"]'::jsonb
      AND "allowed_paths" IS NULL AND "disallowed_paths" IS NULL
  ) AS approved
)
INSERT INTO "source_channel" (
  "id", "name", "mode", "category", "status", "config",
  "manifest", "manifest_sha256", "manifest_version", "connector_kind",
  "base_url", "rate_limit", "pagination", "probe_required",
  "license", "tos_url", "robots_policy", "disabled_reason", "updated_at"
)
SELECT
  gen_random_uuid(), 'ProPak Asia 2026', 'crawl', 'trade_fair', CASE WHEN approved THEN 'ENABLED' ELSE 'DISABLED' END, '{"detail":{"enabled":false,"fields":{"name":".company"}},"list":{"itemSelector":"div.ex-body","maxPages":1,"singlePage":true,"url":"https://www.propakasia.com/ppka/2026/en/list_participants.asp"},"mode":"crawl"}'::jsonb,
  '{"auth":{"type":"none"},"crawl":{"detail":{"enabled":false,"fields":{"name":".company"}},"list":{"itemSelector":"div.ex-body","maxPages":1,"url":"https://www.propakasia.com/ppka/2026/en/list_participants.asp"}},"governance":{"allowedPurpose":["discovery"],"license":"Informa Markets public exhibitor directory — facts reuse, no bulk republication","personalData":false,"robotsPolicy":"A","tosUrl":"https://www.informamarkets.com/terms-of-use"},"meta":{"category":"trade_fair","description":"经典 .asp 服务端渲染；条目 div.ex-body（公司名 .company），约 1500+ 家","docsUrl":"https://www.propakasia.com/ppka/2026/en/list_participants.asp","name":"ProPak Asia 2026","version":1},"pagination":{"type":"none"},"rateLimit":{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5},"transport":{"allowedHosts":["www.propakasia.com"],"baseUrl":"https://www.propakasia.com","maxResponseBytes":5242880,"method":"GET","responseType":"html","timeoutMs":15000}}'::jsonb, 'ead0f48d9eae0ef804bfd522da7f7f966fd27b495d50a5e4e0bf7fd55192f616', 'channel-manifest/v1', 'manifest',
  'https://www.propakasia.com', '{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5}'::jsonb, '{"type":"none"}'::jsonb, NOT approved,
  'Informa Markets public exhibitor directory — facts reuse, no bulk republication', 'https://www.informamarkets.com/terms-of-use', 'A', CASE WHEN approved THEN NULL ELSE 'GOVERNANCE' END, now()
FROM source_approval
WHERE NOT EXISTS (SELECT 1 FROM "source_channel" WHERE "name" = 'ProPak Asia 2026');

-- sicur-madrid (DISABLED)
INSERT INTO "source_channel" (
  "id", "name", "mode", "category", "status", "config",
  "manifest", "manifest_sha256", "manifest_version", "connector_kind",
  "base_url", "rate_limit", "pagination", "probe_required",
  "license", "tos_url", "robots_policy", "disabled_reason", "updated_at"
)
SELECT
  gen_random_uuid(), 'SICUR', 'crawl', 'trade_fair', 'DISABLED', '{"detail":{"enabled":false,"fields":{}},"list":{"itemSelector":".exhibitor-item","maxPages":1,"singlePage":true,"url":"https://www.ifema.es/en/sicur/exhibitors/catalogue"},"mode":"crawl"}'::jsonb,
  '{"auth":{"type":"none"},"crawl":{"detail":{"enabled":false},"list":{"itemSelector":".exhibitor-item","maxPages":1,"url":"https://www.ifema.es/en/sicur/exhibitors/catalogue"}},"meta":{"category":"trade_fair","description":"IFEMA SPA，API 驱动","docsUrl":"https://www.ifema.es/en/sicur/exhibitors/catalogue","name":"SICUR","version":1},"pagination":{"type":"none"},"rateLimit":{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5},"transport":{"allowedHosts":["www.ifema.es"],"baseUrl":"https://www.ifema.es","maxResponseBytes":5242880,"method":"GET","responseType":"html","timeoutMs":15000}}'::jsonb, 'db5da10bdb38c1d360c6e00052bb9717ab108ad640c46db9ce11bccf4dce2d2d', 'channel-manifest/v1', 'manifest',
  'https://www.ifema.es', '{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5}'::jsonb, '{"type":"none"}'::jsonb, true,
  NULL, NULL, NULL, 'OPERATOR', now()
WHERE NOT EXISTS (SELECT 1 FROM "source_channel" WHERE "name" = 'SICUR');

-- southern-manufacturing-electronics-se27 (DISABLED)
INSERT INTO "source_channel" (
  "id", "name", "mode", "category", "status", "config",
  "manifest", "manifest_sha256", "manifest_version", "connector_kind",
  "base_url", "rate_limit", "pagination", "probe_required",
  "license", "tos_url", "robots_policy", "disabled_reason", "updated_at"
)
SELECT
  gen_random_uuid(), 'Southern Manufacturing & Electronics (SE27)', 'crawl', 'trade_fair', 'DISABLED', '{"detail":{"enabled":false,"fields":{}},"list":{"itemSelector":".exhibitor-item","maxPages":1,"singlePage":true,"url":"https://www.southern-manufacturing-electronics.com/en/exhibitors/"},"mode":"crawl"}'::jsonb,
  '{"auth":{"type":"none"},"crawl":{"detail":{"enabled":false},"list":{"itemSelector":".exhibitor-item","maxPages":1,"url":"https://www.southern-manufacturing-electronics.com/en/exhibitors/"}},"meta":{"category":"trade_fair","description":"Easyfairs 站，467 家，A-Z+品类+国家筛选","docsUrl":"https://www.southern-manufacturing-electronics.com/en/exhibitors/","name":"Southern Manufacturing & Electronics (SE27)","version":1},"pagination":{"type":"none"},"rateLimit":{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5},"transport":{"allowedHosts":["www.southern-manufacturing-electronics.com"],"baseUrl":"https://www.southern-manufacturing-electronics.com","maxResponseBytes":5242880,"method":"GET","responseType":"html","timeoutMs":15000}}'::jsonb, '7771129a384637357282a4416dd3e72a1144bde515cb733f1b41d8d773893210', 'channel-manifest/v1', 'manifest',
  'https://www.southern-manufacturing-electronics.com', '{"burst":2,"concurrency":1,"dailyRequests":250,"perDomainDelayMs":2000,"respectRetryAfter":true,"rps":0.5}'::jsonb, '{"type":"none"}'::jsonb, true,
  NULL, NULL, NULL, 'OPERATOR', now()
WHERE NOT EXISTS (SELECT 1 FROM "source_channel" WHERE "name" = 'Southern Manufacturing & Electronics (SE27)');

COMMIT;
