BEGIN;

-- 补齐运行时只读角色对平台注册库表的 SELECT 权限：
-- 迁移 20261109100000_registry_frames 仅向 app_user 授予了 SELECT，遗漏了生产运行时角色
-- runtime_api 与 runtime_worker，导致现网规划期读 registry_frame 与执行期查 registry_entity
-- 触发 permission denied（实跑 run 8b9ff0fa 在 query #1 触发 DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH）。
GRANT SELECT ON TABLE "registry_frame" TO runtime_api, runtime_worker;
GRANT SELECT ON TABLE "registry_snapshot" TO runtime_api, runtime_worker;
GRANT SELECT ON TABLE "registry_entity" TO runtime_api, runtime_worker;
GRANT SELECT ON TABLE "registry_entity_change" TO runtime_api, runtime_worker;
GRANT SELECT ON TABLE "registry_entity_link" TO runtime_api, runtime_worker;

COMMIT;
