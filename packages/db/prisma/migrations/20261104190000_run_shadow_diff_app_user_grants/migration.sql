-- M0⑥ 影子对比表由应用以 upsert 写入（recordRunShadowDiff / runShadowDiff.upsert），
-- app_user 需要 UPDATE；20261104130000_run_shadow_diff 误按 run_event 的 insert-only
-- 模式只授了 SELECT, INSERT，首个真实影子 run 即以 42501 permission denied 失败
-- （2026-11-04 影子两轮验收发现）。没有代码路径删除该表行，DELETE 保持不授。
GRANT UPDATE ON TABLE "run_shadow_diff" TO app_user;
