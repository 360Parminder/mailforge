ALTER TABLE users 
ADD COLUMN ip VARCHAR(48),
ADD COLUMN user_agent TEXT;

CREATE INDEX idx_users_ip ON users(ip);