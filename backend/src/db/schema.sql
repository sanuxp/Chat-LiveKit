CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY,
  external_ref text UNIQUE,
  -- profile supplied by the host web page (nullable: defaults are applied when reading)
  name text,
  email text,
  phone text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One conversation = one LiveKit room (named conv_<id>). Hand-off state lives in these columns.
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY,
  customer_id uuid REFERENCES customers(id),
  status text NOT NULL DEFAULT 'ai',   -- ai | waiting | assigned | escalated_external | closed
  assigned_agent text,                 -- agents.username
  channel text,                        -- tool that caused the escalation
  reason text,
  summary text,
  ai_note text,                        -- one-shot instruction injected into the AI's next turn
  handoff_updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS agents (
  username text PRIMARY KEY,
  display_name text,
  password_hash text NOT NULL,
  max_concurrent int NOT NULL DEFAULT 3,
  online boolean NOT NULL DEFAULT false,
  last_seen timestamptz
);

-- LiveKit has no message history, so every chat message is stored here.
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY,
  seq bigserial,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL,                  -- customer | ai | agent | system
  sender text,                         -- agent username / display name
  kind text NOT NULL DEFAULT 'text',   -- text | notice
  internal boolean NOT NULL DEFAULT false, -- agent-only (e.g. the AI's hand-off summary)
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conv_seq ON messages (conversation_id, seq);
