-- Add API key support for standalone SHARP server usage
-- This allows external frontends to authenticate without JWT tokens

-- Add api_key column to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key VARCHAR(64) UNIQUE;

-- Create index for faster API key lookups
CREATE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key) WHERE api_key IS NOT NULL;

-- Function to generate a secure random API key for a user
CREATE OR REPLACE FUNCTION generate_api_key(user_id INTEGER) 
RETURNS VARCHAR(64) AS $$
DECLARE
    new_key VARCHAR(64);
BEGIN
    -- Generate a 64-character hex key using md5 (available in all PostgreSQL)
    new_key := md5(random()::text || clock_timestamp()::text || user_id::text) || 
               md5(random()::text || clock_timestamp()::text || user_id::text);
    
    -- Update the user's API key
    UPDATE users SET api_key = new_key WHERE id = user_id;
    
    -- Return the generated key
    RETURN new_key;
END;
$$ LANGUAGE plpgsql;

-- Function to revoke (delete) a user's API key
CREATE OR REPLACE FUNCTION revoke_api_key(user_id INTEGER) 
RETURNS BOOLEAN AS $$
BEGIN
    UPDATE users SET api_key = NULL WHERE id = user_id;
    RETURN true;
END;
$$ LANGUAGE plpgsql;

-- Example usage (commented out):
-- Generate an API key for user with ID 1:
-- SELECT generate_api_key(1);

-- Revoke API key for user with ID 1:
-- SELECT revoke_api_key(1);
