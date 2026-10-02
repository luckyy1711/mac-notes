-- Run this in Supabase Dashboard → SQL Editor.
create table if not exists public.notes (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '',
  content text not null default '',
  category text not null default '',
  tags jsonb not null default '[]'::jsonb,
  pinned boolean not null default false,
  is_vault boolean not null default false,
  -- Vault rows contain an AES-encrypted complete note object here; readable fields above stay empty/default.
  encrypted_payload text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vault_payload_required check ((not is_vault) or encrypted_payload is not null)
);
create index if not exists notes_user_updated_idx on public.notes (user_id, updated_at desc);
alter table public.notes enable row level security;
drop policy if exists "Users can read their own notes" on public.notes;
create policy "Users can read their own notes" on public.notes for select to authenticated using (auth.uid() = user_id);
drop policy if exists "Users can insert their own notes" on public.notes;
create policy "Users can insert their own notes" on public.notes for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "Users can update their own notes" on public.notes;
create policy "Users can update their own notes" on public.notes for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Users can delete their own notes" on public.notes;
create policy "Users can delete their own notes" on public.notes for delete to authenticated using (auth.uid() = user_id);

-- Enable cross-device updates for this table (run once per project).
alter publication supabase_realtime add table public.notes;
