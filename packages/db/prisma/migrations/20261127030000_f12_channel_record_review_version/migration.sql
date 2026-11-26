-- Bind approval to the materialized content observed when the review was recorded.
-- Existing review flags remain visible, but lack a version until re-reviewed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.source_channel_record ADD COLUMN reviewed_content_hash varchar(64);

CREATE FUNCTION public.bind_source_channel_record_review_version_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.reviewed_content_hash := NULL;
  ELSIF ROW(NEW.content_hash, NEW.name, NEW.website, NEW.country, NEW.industry,
            NEW.products, NEW.keywords, NEW.source_url)
      IS DISTINCT FROM
        ROW(OLD.content_hash, OLD.name, OLD.website, OLD.country, OLD.industry,
            OLD.products, OLD.keywords, OLD.source_url) THEN
    NEW.reviewed_content_hash := NULL;
    IF OLD.review_status = 'APPROVED' AND NEW.review_status = 'APPROVED' THEN
      NEW.review_status := 'PENDING';
      NEW.reviewed_at := NULL;
      NEW.reviewed_by := NULL;
    END IF;
  ELSIF ROW(NEW.review_status, NEW.reviewed_at, NEW.reviewed_by)
      IS DISTINCT FROM ROW(OLD.review_status, OLD.reviewed_at, OLD.reviewed_by) THEN
    NEW.reviewed_content_hash := CASE
      WHEN NEW.review_status = 'APPROVED' AND NEW.content_hash ~ '^[0-9a-f]{64}$'
      THEN NEW.content_hash
      ELSE NULL
    END;
  ELSE
    NEW.reviewed_content_hash := OLD.reviewed_content_hash;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bind_source_channel_record_review_version
  BEFORE INSERT OR UPDATE ON public.source_channel_record
  FOR EACH ROW EXECUTE FUNCTION public.bind_source_channel_record_review_version_v1();

COMMIT;
