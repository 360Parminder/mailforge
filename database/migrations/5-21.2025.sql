CREATE TABLE IF NOT EXISTS used_hashcash_tokens (
   token TEXT PRIMARY KEY,
   expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_used_hashcash_tokens_expires_at ON used_hashcash_tokens(expires_at);