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

// ── AI Agent (Phase 10) ───────────────────────────────────────
export type AgentMode = "autonomous" | "approve";
export type RiskLevel = "conservative" | "balanced" | "aggressive";

export type AgentConfig = {
  user_id: string;
  enabled: boolean;
  mode: AgentMode;
  risk_level: RiskLevel;
  agent_cash: number;
  allocated_total: number;
  created_at: string;
  updated_at: string;
};

export type AgentHolding = {
  id: string;
  user_id: string;
  symbol: string;
  quantity: number;
  avg_cost: number;
  trailing_stop_price: number | null;
  updated_at: string;
};

export type AgentTransaction = {
  id: string;
  user_id: string;
  symbol: string;
  side: TransactionSide;
  quantity: number;
  price: number;
  total: number;
  reason: string | null;
  created_at: string;
};

export type AgentDecision = {
  id: string;
  user_id: string;
  created_at: string;
  action: string;
  symbol: string | null;
  rationale: string | null;
  signals: unknown;
};

export type AgentSnapshot = {
  id: string;
  user_id: string;
  total_value: number;
  agent_cash: number;
  holdings_value: number;
  captured_at: string; // date (YYYY-MM-DD)
};

export type ProposalStatus = "pending" | "approved" | "rejected" | "superseded";
export type AgentProposalTarget = { symbol: string; weight: number; score: number; beta: number; reason: string };
export type AgentProposalTrade = { kind: "buy" | "trim" | "exit"; side: "buy" | "sell"; symbol: string; quantity: number; price: number; reason: string };
export type AgentProposal = {
  id: string;
  user_id: string;
  created_at: string;
  status: ProposalStatus;
  target: AgentProposalTarget[] | null;
  trades: AgentProposalTrade[] | null;
  rationale: string | null;
  commentary: string | null;
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
      agent_config: {
        Row: AgentConfig;
        Insert: {
          user_id: string;
          enabled?: boolean;
          mode?: AgentMode;
          risk_level?: RiskLevel;
          agent_cash?: number;
          allocated_total?: number;
        };
        Update: {
          enabled?: boolean;
          mode?: AgentMode;
          risk_level?: RiskLevel;
          agent_cash?: number;
          allocated_total?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      agent_holdings: {
        Row: AgentHolding;
        Insert: {
          id?: string;
          user_id: string;
          symbol: string;
          quantity: number;
          avg_cost: number;
          trailing_stop_price?: number | null;
          updated_at?: string;
        };
        Update: {
          quantity?: number;
          avg_cost?: number;
          trailing_stop_price?: number | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      agent_transactions: {
        Row: AgentTransaction;
        Insert: {
          id?: string;
          user_id: string;
          symbol: string;
          side: TransactionSide;
          quantity: number;
          price: number;
          total: number;
          reason?: string | null;
          created_at?: string;
        };
        Update: { [_ in never]: never }; // append-only
        Relationships: [];
      };
      agent_decisions: {
        Row: AgentDecision;
        Insert: {
          id?: string;
          user_id: string;
          action: string;
          symbol?: string | null;
          rationale?: string | null;
          signals?: unknown;
          created_at?: string;
        };
        Update: { [_ in never]: never }; // append-only
        Relationships: [];
      };
      agent_snapshots: {
        Row: AgentSnapshot;
        Insert: {
          id?: string;
          user_id: string;
          total_value: number;
          agent_cash: number;
          holdings_value: number;
          captured_at?: string;
        };
        Update: {
          total_value?: number;
          agent_cash?: number;
          holdings_value?: number;
        };
        Relationships: [];
      };
      agent_proposals: {
        Row: AgentProposal;
        Insert: {
          id?: string;
          user_id: string;
          status?: ProposalStatus;
          target?: unknown;
          trades?: unknown;
          rationale?: string | null;
          commentary?: string | null;
          created_at?: string;
        };
        Update: {
          status?: ProposalStatus;
          target?: unknown;
          trades?: unknown;
          rationale?: string | null;
          commentary?: string | null;
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
