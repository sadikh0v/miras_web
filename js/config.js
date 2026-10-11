/* Настройки Supabase. Эти два значения публичные по замыслу: безопасность держится на правах (RLS) из supabase/setup.sql.
   Dashboard → Project Settings → API (или кнопка Connect): Project URL и publishable / anon key. */
window.MIRAS_CONFIG = {
  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
  supabaseKey: 'YOUR-PUBLISHABLE-KEY',
};
