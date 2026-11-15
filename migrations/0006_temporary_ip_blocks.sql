-- A first burst blocks an IP for 24 hours; a burst after that block has ended
-- blocks it permanently (blocked_until = 'infinity').
ALTER TABLE rate_limit_ips
    ADD COLUMN IF NOT EXISTS blocked_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS strike_count INTEGER NOT NULL DEFAULT 0;

-- IPs blocked under the old permanent rule count as one 24-hour strike.
-- blocked_at is no longer read and can be dropped once this is deployed.
UPDATE rate_limit_ips
SET blocked_until = blocked_at + interval '24 hours', strike_count = 1, blocked_at = NULL
WHERE blocked_at IS NOT NULL;
