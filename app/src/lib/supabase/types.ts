// Hand-written database types for the Supabase schema.
//
// These mirror the SQL in `supabase/migrations/`. Keep them in sync when the
// schema changes. (Later we can generate these with `supabase gen types`.)

// NB: these must be `type` aliases, not `interface`. The Supabase client's
// generics require each Row to satisfy `Record<string, unknown>`, and a TS
// `interface` is NOT assignable to that (no implicit index signature), which
// silently collapses query types to `never`.
export type Profile = {
  id: string; // uuid, references auth.users
  display_name: string | null;
  cash_balance: number; // numeric, defaults to 100000
  created_at: string; // timestamptz (ISO string)
};

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: {
          id: string;
          display_name?: string | null;
          cash_balance?: number;
          created_at?: string;
        };
        Update: {
          display_name?: string | null;
          cash_balance?: number;
        };
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
}
