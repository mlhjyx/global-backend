-- TED 国家税号闸门对齐（2026-11-11）：纯数字国家税号（意大利 partita IVA、西班牙 NIF 等
-- 6–20 位）是公司登记事实（🟢），此前被「防电话 PII」守卫 raw_source_text_contact_safe_v2
-- 整体拒绝——真实数据 85/88 条整条拒收（run 7a616c8a），应用层（#1000）已对 TED 的
-- identifier / attributes.ted.winner_identifier 放行纯数字形态，但 Raw writer 的 DB 侧
-- 闸门独立复核，仍会以 RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID 拒绝（run 4121e533）。
-- 本迁移只放宽这一处：8 位以上纯数字串视为登记号；其余文本仍必须通过 contact-safe 守卫
-- （电话/邮箱/人名守卫对联系人字段不变）。scheme 已限定国别（ted-natid:<iso2>），
-- 不会跨法人串号。
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

CREATE OR REPLACE FUNCTION raw_source_ted_national_identifier_contact_valid_v1(
  p_value TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT normalize(p_value,NFKC)=p_value
    AND octet_length(p_value) BETWEEN 1 AND 80
    AND p_value ~ '^[[:alnum:]][[:alnum:] ._:/-]{0,79}$'
    AND (
      p_value ~ '^[0-9]{6,20}$'
      OR public.raw_source_text_contact_safe_v2(p_value)
    )
$$;

COMMIT;
