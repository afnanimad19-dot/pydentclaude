# Production schema audit — Central Knowledge (migrations 0065–0068)

`verify-production-central-knowledge-schema.sql` is a **read-only** audit that
proves a Supabase project carries the Central Knowledge schema, functions and
privilege posture that Phase 2C relies on. It was validated on the disposable
canary in Steps 72C.31B/31C (28/28 required checks TRUE) and is preserved here
unchanged: SHA-256
`d2ddf7c9f15e0da5b7f37abb2c9461905f5767eb2269d88d66aea5cf1f73677f`.

## What it is, and is not

- ONE `SELECT` statement. Catalog queries plus `count(*)` only.
- It never calls `knowledge_apply_document_changes`, `knowledge_duplicate_resource`,
  `knowledge_reindex_document` or `knowledge_match_chunks`.
- It never reads document content, chunk content, names, URLs, patients or any
  application row. The only data it reports are row counts.
- It contains no credentials and needs none beyond the SQL Editor session.

## Before running: confirm the project identity

The script cannot see which project it runs in. Before pressing Run, confirm
from the dashboard URL bar that the SQL Editor is open on the intended project
(the production project ref when auditing production; the disposable canary
`thqjtoxzkujnljsmkwkp` when rehearsing). The Phase 2C canary tooling refuses
production by design, so a production audit is run **only** from the Supabase
SQL Editor by an operator, never through the canary scripts.

## How to run

1. Supabase Dashboard → SQL Editor → New query.
2. Paste the entire file. Do not edit it, trim it, or split it.
3. Run. Because it is a single statement, the editor shows one result grid
   of 36 rows ordered by `section`, then `check_name`.

The session role in the SQL Editor is normally `postgres`; the row in section
A reports it. That is expected and does not affect any required check.

## Reading the result

Columns: `section`, `check_name`, `kind`, `pass`, `detail`.

- `kind = required` (28 rows, sections B–H): `pass` must be `TRUE` on every row.
- `kind = info` (7 rows, sections A, G, H, I): `pass` is `NULL` on purpose.
  These rows carry context, not a verdict:
  - A: the executing role and read-only flags; a reminder to confirm the
    project from the URL bar.
  - G: the owner of each Central Knowledge table (expected `postgres`).
  - H: default privileges for functions in schema `public`. On Supabase these
    grant EXECUTE to the API roles by default; that is why the migrations
    carry explicit REVOKEs, and the required H rows prove those revokes held.
  - I: row counts for the four tables, the number of `ready` documents with no
    current chunks, and the migration-history table. Non-zero counts are not a
    failure; a non-zero "unindexed ready documents" value means a backfill is
    needed before relying on chunk retrieval for those documents.
- `kind = verdict` (1 row, section Z): `TRUE` only if all 28 required rows are
  `TRUE`. The `detail` shows the count.

**Expected result on a correctly migrated project: 28 of 28 required rows TRUE
and the section Z verdict TRUE.**

## The one platform-role exception (section H)

Supabase provisions the project-owner role `postgres` as a non-superuser LOGIN
role with BYPASSRLS and makes it an INHERIT member of `anon`, `authenticated`
and `service_role`. Migrations 0065/0068 run as that role, so it also owns all
four knowledge functions and holds EXECUTE as owner regardless of membership.
The membership check therefore exempts a member **only** when it is literally
named `postgres` **and** owns all four functions. No other role is exempt:
not superusers, not BYPASSRLS roles, not whichever role happens to own a
function. Any other inheriting member, any PUBLIC or direct EXECUTE grant to a
browser role, and any role that gains EXECUTE through an inheritance chain is
reported in the `detail` as `unexpected:` and fails the row.

## If any required row is FALSE or NULL: STOP

1. Do not enable Central Knowledge for any live agent, and do not assign any
   resource to an agent, until the row is understood and resolved.
2. Copy the FALSE/NULL rows (section, check_name, detail) into the step
   review. The `detail` column names the missing object, the offending role
   or the privilege that differs; nothing in it is sensitive.
3. **Do not apply migrations, grants, revokes or any DDL from the SQL Editor
   as an immediate reaction.** Migrations are applied only through the
   reviewed, hash-pinned manifest tooling under a separate written approval;
   an ad-hoc fix from the editor bypasses the closed-world hash validation and
   the pre/post evidence that tooling records.
4. A FALSE in section B means this is not the expected database; nothing
   else in the result can be trusted.
5. A FALSE in C, D, E or F means the corresponding migration is absent or
   partial. The runtime degrades silently to the legacy per-agent knowledge
   blob in that state, so a "working" agent proves nothing.
6. A FALSE in G or H is a privilege defect: a browser role or PUBLIC can reach
   a knowledge table or execute a knowledge function. Treat it as a security
   finding and bring it to review before any content is uploaded.

## Keeping this file honest

The file is preserved exactly as validated. Any change to it, however small,
must be re-validated the same way (offline single-statement parser check plus
a read-only canary run) and the SHA-256 above updated in the same change.
