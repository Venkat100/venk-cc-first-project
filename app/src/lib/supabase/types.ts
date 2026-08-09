// Hand-written database types for the Supabase schema.
//
// These mirror the SQL in `supabase/migrations/`. Keep them in sync when the
// schema changes. (Later we can generate these with `supabase gen types`.)

// NB: these must be `type` aliases, not `interface`. The Supabase client's
// generics require each Row to satisfy `Record<string, unknown>`, and a TS
// `interface` is NOT assignable to that (no implicit index signature), which
// silently collapses query types to `never`.
export type MarginStatus = "ok" | "warning" | "call";

export type Profile = {
  id: string; // uuid, references auth.users
  display_name: string | null;
  cash_balance: number; // numeric, current virtual buying power
  // The ACTUAL amount this account started with (or was last reset to) —
  // 100000 for every pre-2026-08-09 account (historical fact), 25000 for
  // every account created or reset since (0016_starting_capital.sql).
  // Dashboard total-return math reads THIS, never a hardcoded constant.
  starting_capital: number;
  created_at: string; // timestamptz (ISO string)
  // Margin (M1) — opt-in, off by default.
  margin_enabled: boolean;
  margin_loan: number;
  margin_status: MarginStatus;
  last_interest_accrued_at: string | null; // date (YYYY-MM-DD)
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

export type Insight = {
  id: string;
  user_id: string;
  kind: string;
  payload: unknown;
  created_at: string; // date (YYYY-MM-DD)
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

// ── Options & Margin (O2) ──────────────────────────────────────
export type OptionType = "call" | "put";
// O4: 'expired' (worthless, $0 credited) / 'settled' (in-the-money, cash
// credited) are written only by the daily expiration cron, never a trade.
export type OptionSide = "buy_to_open" | "sell_to_close" | "expired" | "settled";

export type OptionPosition = {
  id: string;
  user_id: string;
  contract_id: string; // e.g. "NVDA-2026-09-18-C-200"
  symbol: string;
  opt_type: OptionType;
  strike: number;
  expiry: string; // date (YYYY-MM-DD)
  contracts: number;
  avg_premium: number; // per-contract, not ×100
  opened_at: string;
  updated_at: string;
};

export type OptionTransaction = {
  id: string;
  user_id: string;
  contract_id: string;
  symbol: string;
  side: OptionSide;
  contracts: number;
  premium: number; // per-contract, at fill
  total: number; // premium × 100 × contracts
  created_at: string;
};

// ── Margin (M1) ─────────────────────────────────────────────
export type MarginEventKind = "enabled" | "disabled" | "borrow" | "repay" | "interest" | "warning" | "call" | "liquidation";

export type MarginEvent = {
  id: string;
  user_id: string;
  kind: MarginEventKind;
  amount: number;
  detail: unknown;
  created_at: string;
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
        // M1: the DB now REVOKEs blanket UPDATE from `authenticated` and
        // grants UPDATE(display_name) only (0012) — cash_balance/margin_*
        // are written exclusively by SECURITY DEFINER functions. This type
        // is deliberately narrowed to match: attempting to update anything
        // else from client code is now a real DB-level permission error,
        // not just a convention, so the type should say so too.
        Update: {
          display_name?: string | null;
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
      insights: {
        Row: Insight;
        Insert: {
          id?: string;
          user_id: string;
          kind: string;
          payload: unknown;
          created_at?: string;
        };
        Update: {
          payload?: unknown;
        };
        Relationships: [];
      };
      option_positions: {
        Row: OptionPosition;
        Insert: {
          id?: string;
          user_id: string;
          contract_id: string;
          symbol: string;
          opt_type: OptionType;
          strike: number;
          expiry: string;
          contracts: number;
          avg_premium: number;
          opened_at?: string;
          updated_at?: string;
        };
        Update: { [_ in never]: never }; // written only by execute_option_trade (service_role)
        Relationships: [];
      };
      option_transactions: {
        Row: OptionTransaction;
        Insert: {
          id?: string;
          user_id: string;
          contract_id: string;
          symbol: string;
          side: OptionSide;
          contracts: number;
          premium: number;
          total: number;
          created_at?: string;
        };
        Update: { [_ in never]: never }; // append-only
        Relationships: [];
      };
      margin_events: {
        Row: MarginEvent;
        Insert: {
          id?: string;
          user_id: string;
          kind: MarginEventKind;
          amount?: number;
          detail?: unknown;
          created_at?: string;
        };
        Update: { [_ in never]: never }; // append-only, written only by margin SQL functions (service_role)
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
}
