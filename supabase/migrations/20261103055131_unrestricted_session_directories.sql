-- Sessions are rooted at an arbitrary absolute directory chosen by ChatGPT.
-- `workspace_key` remains an informational label for backwards compatibility.
alter table coord.kilo_sessions
  add column directory text not null default '/home/ubuntu';

alter table coord.kilo_sessions
  add constraint kilo_sessions_directory_absolute
  check (left(directory, 1) = '/' and octet_length(directory) <= 4096);

-- The existing PostgREST view uses select * and must be refreshed to expose
-- the appended directory column. Preserve service_role grants and invoker mode.
create or replace view public.kilo_sessions with (security_invoker = true)
  as select * from coord.kilo_sessions;

notify pgrst, 'reload schema';
