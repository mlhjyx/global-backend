-- Application reads must pass the run, artifact, source and deletion checks in the bound RPC.
REVOKE ALL ON public.discovery_v3_manufacturer_evidence FROM app_user;
