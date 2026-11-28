-- The feed's position when a webhook or a rule was made: it hears the
-- events after that one, also when the dispatcher, behind on a busy server,
-- reaches earlier ones only once it is there. Zero for one made before this
-- was kept: it hears every event not yet dispatched, as it did.
ALTER TABLE webhooks ADD COLUMN created_seq {{BIGINT}} NOT NULL DEFAULT 0;
ALTER TABLE rules ADD COLUMN created_seq {{BIGINT}} NOT NULL DEFAULT 0;
