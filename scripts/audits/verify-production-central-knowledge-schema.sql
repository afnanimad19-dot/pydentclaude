-- =============================================================================
-- Pydent Phase 2C — Step 72C.31A
-- PRODUCTION SCHEMA VERIFICATION for Central Knowledge (migrations 0065–0068)
-- READ-ONLY. ONE statement. Catalog queries + COUNT(*) only.
--
-- HOW TO RUN: Supabase Dashboard → SQL Editor → new query → paste this whole
-- file → Run. It is a single SELECT, so the editor shows one result grid.
--
-- WHAT IT DOES NOT DO: it never calls knowledge_apply_document_changes,
-- knowledge_duplicate_resource, knowledge_reindex_document or
-- knowledge_match_chunks; it never reads document content, chunk content,
-- names, URLs or any application row — only object existence, privileges and
-- row COUNTS.
--
-- HOW TO READ THE RESULT:
--   kind = 'required'  → pass must be TRUE. Any FALSE/NULL ⇒ STOP; the Central
--                        Knowledge runtime is not safe to rely on in production.
--   kind = 'info'      → context for the reviewer; pass is NULL on purpose.
--   The last row, section 'Z', is the OVERALL verdict:
--   TRUE only if every required check passed.
-- =============================================================================
with
fn as (
  select
    to_regprocedure('public.knowledge_apply_document_changes(uuid,uuid,uuid,jsonb,jsonb)')::oid as apply_oid,
    to_regprocedure('public.knowledge_duplicate_resource(uuid,uuid,text,uuid)')::oid           as dup_oid,
    to_regprocedure('public.knowledge_reindex_document(uuid,uuid,text,jsonb)')::oid            as reindex_oid,
    to_regprocedure('public.knowledge_match_chunks(uuid,uuid,text,integer)')::oid              as match_oid
),
-- Effective EXECUTE grantees of one function. coalesce(proacl, acldefault) is
-- essential: a NULL proacl means the IMPLICIT default, which grants EXECUTE to
-- PUBLIC — exactly the state a missing REVOKE would leave behind.
fn_acl as (
  select p.oid,
         pg_get_userbyid(p.proowner) as owner_name,
         p.prosecdef,
         p.provolatile,
         p.proconfig,
         (select string_agg(case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end, ', ' order by a.grantee)
            from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           where a.privilege_type = 'EXECUTE') as execute_grantees,
         (select bool_or(a.grantee = 0)
            from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           where a.privilege_type = 'EXECUTE') as public_has_execute,
         (select bool_and(a.grantee = p.proowner or pg_get_userbyid(a.grantee) = 'service_role')
            from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           where a.privilege_type = 'EXECUTE') as only_owner_and_service_role
    from pg_proc p
   where p.oid in (select apply_oid from fn union select dup_oid from fn union select reindex_oid from fn union select match_oid from fn)
),
roles as (
  select
    exists (select 1 from pg_roles where rolname = 'anon')          as has_anon,
    exists (select 1 from pg_roles where rolname = 'authenticated') as has_authenticated,
    exists (select 1 from pg_roles where rolname = 'service_role')  as has_service_role,
    exists (select 1 from pg_roles where rolname = 'authenticator') as has_authenticator
),
-- The ONE platform-role exception (Step 72C.31C). Supabase provisions the
-- project-owner role `postgres` as a NON-superuser LOGIN role with BYPASSRLS
-- and grants it INHERIT membership in anon / authenticated / service_role so
-- dashboard SQL can act as the API roles. Migrations 0065/0068 run AS postgres,
-- so postgres is also the OWNER of all four knowledge functions and holds
-- EXECUTE on them as owner regardless of any membership — the membership adds
-- no privilege it does not already have. The exception therefore applies ONLY
-- when BOTH hold: the role is literally named 'postgres' AND it owns all four
-- knowledge functions. It is NOT a blanket exemption for BYPASSRLS roles, for
-- superusers, or for whoever happens to own a function: any other role that
-- inherits service_role, or that owns the functions instead of postgres, is
-- reported as unexpected.
postgres_owner as (
  select (select count(*) from fn_acl a where a.owner_name = 'postgres') = 4 as owns_all
),
-- Roles that are MEMBERS of service_role: an INHERITing member holds every
-- service_role privilege transitively, including EXECUTE on the functions.
sr_members as (
  select string_agg(m.rolname
                    || case when m.rolinherit then ' (INHERIT)' else ' (noinherit)' end
                    || case when m.rolcanlogin then ' [login]' else '' end
                    || case when m.rolsuper then ' [superuser]' else '' end
                    || case when m.rolname = 'postgres' and (select owns_all from postgres_owner) then ' [exempt: platform owner, owns the functions]' else '' end,
                    ', ' order by m.rolname) as members,
         coalesce(bool_or(m.rolinherit and not (m.rolname = 'postgres' and (select owns_all from postgres_owner))), false) as unexpected_inheriting_member
    from pg_auth_members am
    join pg_roles r on r.oid = am.roleid and r.rolname = 'service_role'
    join pg_roles m on m.oid = am.member
),
-- EVERY role whose EFFECTIVE privilege (direct grant, PUBLIC grant, or any
-- chain of INHERIT memberships) includes EXECUTE on knowledge_match_chunks.
-- Allowed holders: superusers (implicit and unrevocable), service_role itself,
-- and postgres only as the function owner (see postgres_owner). Anything else
-- — a stray grant, a PUBLIC grant, an inheriting member of service_role or of
-- postgres — appears in unexpected_holders and fails the check.
effective_exec as (
  select string_agg(r.rolname || case when r.rolcanlogin then ' [login]' else '' end, ', ' order by r.rolname)
           filter (where not r.rolsuper and r.rolname <> 'service_role'
                     and not (r.rolname = 'postgres' and (select owns_all from postgres_owner))) as unexpected_holders,
         string_agg(r.rolname || case when r.rolsuper then ' [superuser]' else '' end, ', ' order by r.rolname) as all_holders
    from pg_roles r, fn
   where fn.match_oid is not null
     and has_function_privilege(r.oid, fn.match_oid, 'EXECUTE')
),
tbl as (
  select c.relname as table_name, c.oid, c.relrowsecurity as rls,
         pg_get_userbyid(c.relowner) as owner_name,
         (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies,
         has_table_privilege('anon', c.oid, 'select,insert,update,delete,truncate,references,trigger') as anon_any,
         has_table_privilege('authenticated', c.oid, 'select,insert,update,delete,truncate,references,trigger') as authenticated_any,
         (has_table_privilege('service_role', c.oid, 'select') and has_table_privilege('service_role', c.oid, 'insert')
          and has_table_privilege('service_role', c.oid, 'update') and has_table_privilege('service_role', c.oid, 'delete')) as service_role_crud
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('knowledge_resources', 'knowledge_documents', 'agent_knowledge_resources', 'knowledge_chunks')
     and (select has_service_role and has_anon and has_authenticated from roles)
),
-- Exact row counts WITHOUT a static reference to a table that may not exist
-- (query_to_xml evaluates lazily, only when the table is present).
counts as (
  select
    case when to_regclass('public.knowledge_resources') is not null
         then (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.knowledge_resources', false, true, '')))[1]::text end as resources,
    case when to_regclass('public.knowledge_documents') is not null
         then (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.knowledge_documents', false, true, '')))[1]::text end as documents,
    case when to_regclass('public.agent_knowledge_resources') is not null
         then (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.agent_knowledge_resources', false, true, '')))[1]::text end as assignments,
    case when to_regclass('public.knowledge_chunks') is not null
         then (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.knowledge_chunks', false, true, '')))[1]::text end as chunks,
    case when to_regclass('supabase_migrations.schema_migrations') is not null
         then (xpath('/row/n/text()', query_to_xml('select count(*) as n from supabase_migrations.schema_migrations', false, true, '')))[1]::text end as history_rows,
    case when to_regclass('supabase_migrations.schema_migrations') is not null
         then (xpath('/row/v/text()', query_to_xml(
                $q$select coalesce(string_agg(version, ', ' order by version), '(none)') as v
                     from supabase_migrations.schema_migrations
                    where version ~ '006[5-8]' or version ~* 'knowledge|chunk|scheduling'$q$, false, true, '')))[1]::text end as history_matches
),
checks (section, check_name, kind, pass, detail) as (
  -- ---------------------------------------------------------------- A. session
  select 'A', 'session: executing role / read-only flags (context only)', 'info', null::boolean,
         format('current_user=%s session_user=%s transaction_read_only=%s server_version_num=%s',
                current_user, session_user, current_setting('transaction_read_only'), current_setting('server_version_num'))
  union all
  select 'A', 'session: this is NOT the disposable canary and NOT the A7 project (project ref is not visible from SQL; confirm the URL bar shows the production project)', 'info', null, 'operator confirms from the dashboard URL'
  union all
  -- ---------------------------------------------------------------- B. baseline
  select 'B', 'baseline 0001-0064: public.patients, public.workspaces, public.voice_number_assignments exist', 'required',
         to_regclass('public.patients') is not null and to_regclass('public.workspaces') is not null and to_regclass('public.voice_number_assignments') is not null,
         format('patients=%s workspaces=%s voice_number_assignments=%s',
                to_regclass('public.patients') is not null, to_regclass('public.workspaces') is not null, to_regclass('public.voice_number_assignments') is not null)
  union all
  select 'B', 'baseline: public.agents exists and has workspace_id (0065 trigger target)', 'required',
         exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'agents' and column_name = 'workspace_id'), null
  union all
  select 'B', 'roles: anon, authenticated, service_role, authenticator exist (Supabase API roles)', 'required',
         (select has_anon and has_authenticated and has_service_role and has_authenticator from roles),
         (select format('anon=%s authenticated=%s service_role=%s authenticator=%s', has_anon, has_authenticated, has_service_role, has_authenticator) from roles)
  union all
  -- ---------------------------------------------------------------- C. 0065 objects
  select 'C', '0065: knowledge_resources, knowledge_documents, agent_knowledge_resources tables exist', 'required',
         to_regclass('public.knowledge_resources') is not null and to_regclass('public.knowledge_documents') is not null and to_regclass('public.agent_knowledge_resources') is not null,
         format('resources=%s documents=%s assignments=%s', to_regclass('public.knowledge_resources') is not null,
                to_regclass('public.knowledge_documents') is not null, to_regclass('public.agent_knowledge_resources') is not null)
  union all
  select 'C', '0065: knowledge_apply_document_changes(uuid,uuid,uuid,jsonb,jsonb) exists', 'required', (select apply_oid is not null from fn), null
  union all
  select 'C', '0065: knowledge_duplicate_resource(uuid,uuid,text,uuid) exists', 'required', (select dup_oid is not null from fn), null
  union all
  select 'C', '0065: the four triggers exist (agent ws check, 50-doc limit, two updated_at touches)', 'required',
         (select count(*) = 4 from pg_trigger t
           where not t.tgisinternal
             and t.tgname in ('agent_knowledge_resources_check_ws', 'knowledge_documents_limit', 'knowledge_resources_touch', 'knowledge_documents_touch')
             and t.tgrelid in (to_regclass('public.agent_knowledge_resources'), to_regclass('public.knowledge_documents'), to_regclass('public.knowledge_resources'))),
         (select coalesce(string_agg(t.tgname, ', ' order by t.tgname), '(none)') from pg_trigger t
           where not t.tgisinternal and t.tgname in ('agent_knowledge_resources_check_ws', 'knowledge_documents_limit', 'knowledge_resources_touch', 'knowledge_documents_touch'))
  union all
  select 'C', '0065: composite FK agent_knowledge_resources → knowledge_resources(workspace_id,id) and documents → resources(workspace_id,id,type)', 'required',
         exists (select 1 from pg_constraint where conname = 'agent_knowledge_resources_resource_fk' and contype = 'f' and conrelid = to_regclass('public.agent_knowledge_resources'))
         and exists (select 1 from pg_constraint where conname = 'knowledge_documents_resource_fk' and contype = 'f' and conrelid = to_regclass('public.knowledge_documents')), null
  union all
  -- ---------------------------------------------------------------- D. 0066
  select 'D', '0066: clinic_settings.slot_minutes column exists (independent of Central Knowledge; the canary applied it)', 'required',
         exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'clinic_settings' and column_name = 'slot_minutes'), null
  union all
  -- ---------------------------------------------------------------- E. 0067 grants
  select 'E', '0067: service_role holds SELECT/INSERT/UPDATE/DELETE on the three 0065 tables', 'required',
         (select count(*) = 3 and bool_and(service_role_crud) from tbl where table_name in ('knowledge_resources', 'knowledge_documents', 'agent_knowledge_resources')),
         (select string_agg(table_name || '=' || service_role_crud, ', ' order by table_name) from tbl where table_name in ('knowledge_resources', 'knowledge_documents', 'agent_knowledge_resources'))
  union all
  -- ---------------------------------------------------------------- F. 0068 objects
  select 'F', '0068: knowledge_chunks table exists', 'required', to_regclass('public.knowledge_chunks') is not null, null
  union all
  select 'F', '0068: knowledge_documents_ws_res_id_key unique (workspace_id, resource_id, id) exists (composite-FK target)', 'required',
         exists (select 1 from pg_constraint where conname = 'knowledge_documents_ws_res_id_key' and contype = 'u' and conrelid = to_regclass('public.knowledge_documents')), null
  union all
  select 'F', '0068: knowledge_chunks_document_fk composite FK + (document_id, chunk_index) unique + content 1..4000 check exist', 'required',
         exists (select 1 from pg_constraint where conname = 'knowledge_chunks_document_fk' and contype = 'f' and conrelid = to_regclass('public.knowledge_chunks'))
         and exists (select 1 from pg_constraint where conname = 'knowledge_chunks_doc_uniq' and contype = 'u' and conrelid = to_regclass('public.knowledge_chunks'))
         and exists (select 1 from pg_constraint where conname = 'knowledge_chunks_content_chk' and contype = 'c' and conrelid = to_regclass('public.knowledge_chunks')), null
  union all
  select 'F', '0068: knowledge_chunks.fts is a STORED generated tsvector; content_hash column present', 'required',
         exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.knowledge_chunks') and a.attname = 'fts'
                    and a.attgenerated = 's' and format_type(a.atttypid, a.atttypmod) = 'tsvector' and not a.attisdropped)
         and exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.knowledge_chunks') and a.attname = 'content_hash' and not a.attisdropped), null
  union all
  select 'F', '0068: GIN index knowledge_chunks_fts_idx and btree knowledge_chunks_ws_resource_idx exist', 'required',
         exists (select 1 from pg_class i join pg_index x on x.indexrelid = i.oid join pg_am am on am.oid = i.relam
                  where i.relname = 'knowledge_chunks_fts_idx' and am.amname = 'gin' and x.indrelid = to_regclass('public.knowledge_chunks'))
         and exists (select 1 from pg_class i join pg_index x on x.indexrelid = i.oid
                  where i.relname = 'knowledge_chunks_ws_resource_idx' and x.indrelid = to_regclass('public.knowledge_chunks')), null
  union all
  select 'F', '0068: knowledge_reindex_document(uuid,uuid,text,jsonb) exists', 'required', (select reindex_oid is not null from fn), null
  union all
  select 'F', '0068: knowledge_match_chunks(uuid,uuid,text,integer) exists', 'required', (select match_oid is not null from fn), null
  union all
  -- ---------------------------------------------------------------- G. table access posture (all four tables)
  select 'G', 'tables: RLS ENABLED on all four Central Knowledge tables', 'required',
         (select count(*) = 4 and bool_and(rls) from tbl),
         (select coalesce(string_agg(table_name || '=' || rls, ', ' order by table_name), '(no tables found)') from tbl)
  union all
  select 'G', 'tables: ZERO row-level policies on all four (deny-all for browser roles; service_role bypasses RLS)', 'required',
         (select count(*) = 4 and bool_and(policies = 0) from tbl),
         (select coalesce(string_agg(table_name || '=' || policies, ', ' order by table_name), '(no tables found)') from tbl)
  union all
  select 'G', 'tables: anon and authenticated hold NO privilege of any kind on all four', 'required',
         (select count(*) = 4 and bool_and(not anon_any and not authenticated_any) from tbl),
         (select coalesce(string_agg(table_name || ': anon=' || anon_any || ' authenticated=' || authenticated_any, '; ' order by table_name), '(no tables found)') from tbl)
  union all
  select 'G', 'tables: service_role holds CRUD on all four (0067 for the three, 0068 for chunks)', 'required',
         (select count(*) = 4 and bool_and(service_role_crud) from tbl),
         (select coalesce(string_agg(table_name || '=' || service_role_crud, ', ' order by table_name), '(no tables found)') from tbl)
  union all
  select 'G', 'tables: owner of each table (expected postgres)', 'info', null,
         (select coalesce(string_agg(table_name || '=' || owner_name, ', ' order by table_name), '(no tables found)') from tbl)
  union all
  -- ---------------------------------------------------------------- H. function EXECUTE posture (the critical one: knowledge_match_chunks)
  select 'H', 'knowledge_match_chunks: EXECUTE grantees are ONLY the owner and service_role; PUBLIC has none (explicit ACL, not implicit default)', 'required',
         (select a.only_owner_and_service_role and not coalesce(a.public_has_execute, false) and a.execute_grantees like '%service_role%'
            from fn_acl a where a.oid = (select match_oid from fn)),
         (select format('owner=%s execute_grantees=[%s]', a.owner_name, a.execute_grantees) from fn_acl a where a.oid = (select match_oid from fn))
  union all
  select 'H', 'knowledge_match_chunks: effective EXECUTE (incl. PUBLIC + inherited membership): anon=false authenticated=false authenticator=false service_role=true', 'required',
         (select case when (select has_anon and has_authenticated and has_service_role and has_authenticator from roles) and match_oid is not null
                      then not has_function_privilege('anon', match_oid, 'EXECUTE')
                       and not has_function_privilege('authenticated', match_oid, 'EXECUTE')
                       and not has_function_privilege('authenticator', match_oid, 'EXECUTE')
                       and has_function_privilege('service_role', match_oid, 'EXECUTE')
                      else false end from fn),
         (select case when (select has_anon and has_authenticated and has_service_role and has_authenticator from roles) and match_oid is not null
                      then format('anon=%s authenticated=%s authenticator=%s service_role=%s',
                                  has_function_privilege('anon', match_oid, 'EXECUTE'), has_function_privilege('authenticated', match_oid, 'EXECUTE'),
                                  has_function_privilege('authenticator', match_oid, 'EXECUTE'), has_function_privilege('service_role', match_oid, 'EXECUTE'))
                      else 'function or role missing' end from fn)
  union all
  select 'H', 'knowledge_match_chunks: SECURITY INVOKER, STABLE, search_path pinned to empty', 'required',
         (select not a.prosecdef and a.provolatile = 's'
                 and exists (select 1 from unnest(coalesce(a.proconfig, '{}'::text[])) c where c ~ '^search_path=(""|)$')
            from fn_acl a where a.oid = (select match_oid from fn)),
         (select format('security_definer=%s volatility=%s proconfig=%s', a.prosecdef, a.provolatile, a.proconfig) from fn_acl a where a.oid = (select match_oid from fn))
  union all
  select 'H', 'knowledge_reindex_document: EXECUTE only owner + service_role; PUBLIC none; SECURITY INVOKER; search_path empty', 'required',
         (select a.only_owner_and_service_role and not coalesce(a.public_has_execute, false) and a.execute_grantees like '%service_role%' and not a.prosecdef
                 and exists (select 1 from unnest(coalesce(a.proconfig, '{}'::text[])) c where c ~ '^search_path=(""|)$')
            from fn_acl a where a.oid = (select reindex_oid from fn)),
         (select format('owner=%s execute_grantees=[%s] security_definer=%s', a.owner_name, a.execute_grantees, a.prosecdef) from fn_acl a where a.oid = (select reindex_oid from fn))
  union all
  select 'H', 'knowledge_apply_document_changes: EXECUTE only owner + service_role; PUBLIC none; SECURITY INVOKER', 'required',
         (select a.only_owner_and_service_role and not coalesce(a.public_has_execute, false) and a.execute_grantees like '%service_role%' and not a.prosecdef
            from fn_acl a where a.oid = (select apply_oid from fn)),
         (select format('owner=%s execute_grantees=[%s] security_definer=%s', a.owner_name, a.execute_grantees, a.prosecdef) from fn_acl a where a.oid = (select apply_oid from fn))
  union all
  select 'H', 'knowledge_duplicate_resource: EXECUTE only owner + service_role; PUBLIC none; SECURITY INVOKER', 'required',
         (select a.only_owner_and_service_role and not coalesce(a.public_has_execute, false) and a.execute_grantees like '%service_role%' and not a.prosecdef
            from fn_acl a where a.oid = (select dup_oid from fn)),
         (select format('owner=%s execute_grantees=[%s] security_definer=%s', a.owner_name, a.execute_grantees, a.prosecdef) from fn_acl a where a.oid = (select dup_oid from fn))
  union all
  select 'H', 'service_role membership + effective EXECUTE on knowledge_match_chunks: no unexpected INHERITing member of service_role (only the platform owner postgres, as owner of the functions, is exempt), and no role beyond superusers, service_role and that owner holds effective EXECUTE', 'required',
         (select not unexpected_inheriting_member from sr_members)
         and (select unexpected_holders is null from effective_exec)
         and (select match_oid is not null from fn),
         (select format('members of service_role: %s | effective EXECUTE holders: %s | unexpected: %s',
                        coalesce(sm.members, '(none)'), coalesce(ee.all_holders, '(none)'), coalesce(ee.unexpected_holders, '(none)'))
            from sr_members sm, effective_exec ee)
  union all
  select 'H', 'default privileges for FUNCTIONS in schema public (would affect a future CREATE OR REPLACE; informational)', 'info', null,
         (select coalesce(string_agg(format('owner=%s grantees=%s', pg_get_userbyid(d.defaclrole),
                   (select string_agg(case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end, '/') from aclexplode(d.defaclacl) a)), '; '), '(no function default ACLs in public)')
            from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace where n.nspname = 'public' and d.defaclobjtype = 'f')
  union all
  -- ---------------------------------------------------------------- I. data presence (counts only — decides whether a backfill question exists)
  select 'I', 'data: row counts (resources / documents / assignments / chunks)', 'info', null,
         (select format('resources=%s documents=%s assignments=%s chunks=%s', coalesce(resources, 'n/a'), coalesce(documents, 'n/a'), coalesce(assignments, 'n/a'), coalesce(chunks, 'n/a')) from counts)
  union all
  select 'I', 'data: ready documents that currently have NO chunks (would be invisible to agents once any sibling is indexed)', 'info', null,
         case when to_regclass('public.knowledge_documents') is not null and to_regclass('public.knowledge_chunks') is not null
              then 'unindexed_ready_documents=' || (xpath('/row/n/text()', query_to_xml(
                     $q$select count(*) as n from public.knowledge_documents d
                         where d.status = 'ready'
                           and not exists (select 1 from public.knowledge_chunks c where c.document_id = d.id and c.content_hash = d.content_hash)$q$, false, true, '')))[1]::text
              else 'n/a (tables missing)' end
  union all
  select 'I', 'migration history: supabase_migrations.schema_migrations rows and any 0065–0068-like versions (the app applies migrations by SQL-editor paste, so this is usually empty)', 'info', null,
         (select format('history_table=%s rows=%s matches=%s', to_regclass('supabase_migrations.schema_migrations') is not null, coalesce(history_rows, 'n/a'), coalesce(history_matches, 'n/a')) from counts)
),
verdict as (
  select bool_and(coalesce(pass, false)) as all_required_pass, count(*) filter (where kind = 'required') as required_total,
         count(*) filter (where kind = 'required' and pass) as required_pass
    from checks where kind = 'required'
)
select section, check_name, kind, pass, detail from checks
union all
select 'Z', 'OVERALL: every required check passed → Central Knowledge schema, functions and grants are production-ready for Phase 2C', 'verdict',
       coalesce(all_required_pass, false),
       format('required passed %s of %s. If FALSE: STOP — do not enable Central Knowledge for any live agent; list the FALSE rows and bring them to review.', required_pass, required_total)
  from verdict
order by 1, 2;
