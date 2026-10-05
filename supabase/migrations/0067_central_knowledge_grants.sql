-- Pydent — migration 67: service_role CRUD grants for the Central Knowledge tables.
--
-- Repairs the environmental assumption in migration 0065 (which stays frozen —
-- it is already applied and independently validated): 0065 granted service_role
-- EXECUTE on the two Central KB write functions but relied on project default
-- privileges to give service_role table access. On projects whose default ACLs
-- do not grant DML to the API roles, the SECURITY INVOKER function bodies and
-- the server's direct CRUD path (src/lib/knowledge-server.ts, service role)
-- fail with 42501.
--
-- This migration does exactly ONE thing: grant SELECT/INSERT/UPDATE/DELETE on
-- the three Central KB tables to service_role. Nothing else changes:
--   * anon / authenticated stay fully denied (no grants here, none elsewhere);
--   * RLS stays enabled with zero policies (service_role passes via its
--     existing BYPASSRLS attribute, which this migration does not touch);
--   * both Central KB functions stay SECURITY INVOKER with their existing
--     EXECUTE grants;
--   * no default privileges, no policies, no schema objects, no other roles,
--     no other tables.
-- Idempotent: GRANT is additive and safe to re-run.
--
-- The repository-wide question (baseline tables also lack API-role DML under
-- hardened default ACLs) is deliberately NOT addressed here; it is recorded as
-- a separate future security/deployment-hardening issue.

grant select, insert, update, delete
  on table public.knowledge_resources,
           public.knowledge_documents,
           public.agent_knowledge_resources
  to service_role;
