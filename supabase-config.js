/*
 * Public browser configuration for the Mac Notes Supabase project.
 *
 * The anon/publishable key intentionally belongs in the browser: it identifies
 * this public client, while the database's Row Level Security policies enforce
 * access control. Never place a service_role key, database password, vault
 * passcode, or encryption key in this file.
 */
window.MAC_NOTES_SUPABASE_CONFIG = {
  url: "https://lqjepymsfcpmnpsesmpl.supabase.co",
  anonKey: "YOUR_ANON_OR_PUBLISHABLE_KEY"
};
