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

export type Holding = {
  id: string;
  user_id: string;
  symbol: string;
  quantity: number;
  avg_cost: number;
  updated_at: string;
};

export type TransactionSide = "buy" | "sell";

export type Transaction = {
  id: string;
  user_id: string;
  symbol: string;
  side: TransactionSide;
  quantity: number;
  price: number;
  total: number;
  order_type: string; // 'market' | 'limit'
  status: string; // 'filled' | ...
  created_at: string;
};

export type WatchlistItem = {
  id: string;
  user_id: string;
  symbol: string;
  created_at: string;
};

export type PortfolioSnapshot = {
  id: string;
  user_id: string;
  total_value: number;
  cash: number;
  holdings_value: number;
  captured_at: string; // date (YYYY-MM-DD)
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
      holdings: {
        Row: Holding;
        Insert: {
          id?: string;
          user_id: string;
          symbol: string;
          quantity: number;
          avg_cost: number;
          updated_at?: string;
        };
        Update: {
          symbol?: string;
          quantity?: number;
          avg_cost?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      transactions: {
        Row: Transaction;
        Insert: {
          id?: string;
          user_id: string;
          symbol: string;
          side: TransactionSide;
          quantity: number;
          price: number;
          total: number;
          order_type?: string;
          status?: string;
          created_at?: string;
        };
        Update: { [_ in never]: never }; // append-only: no client updates
        Relationships: [];
      };
      watchlist: {
        Row: WatchlistItem;
        Insert: {
          id?: string;
          user_id: string;
          symbol: string;
          created_at?: string;
        };
        Update: {
          symbol?: string;
        };
        Relationships: [];
      };
      portfolio_snapshots: {
        Row: PortfolioSnapshot;
        Insert: {
          id?: string;
          user_id: string;
          total_value: number;
          cash: number;
          holdings_value: number;
          captured_at?: string;
        };
        Update: {
          total_value?: number;
          cash?: number;
          holdings_value?: number;
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
