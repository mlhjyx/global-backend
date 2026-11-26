ALTER TABLE public.discovery_company_job
  ADD COLUMN streaming_l2_contacts_created INTEGER,
  ADD CONSTRAINT dcj_streaming_l2_contacts_nonnegative
    CHECK (streaming_l2_contacts_created >= 0);
