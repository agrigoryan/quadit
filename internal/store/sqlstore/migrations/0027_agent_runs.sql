-- A run that Quadit's runner started on a person's computer is an agent
-- session like any other, with what it ran, where, and how it ended: the
-- program and its own session id, the machine and the folder (a label: the
-- path stays on the machine), why it waits, did not start or failed, the
-- items it covered, and a stop a member asked for. One row is one start of
-- the program.
ALTER TABLE agent_sessions ADD COLUMN program TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_sessions ADD COLUMN program_session TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_sessions ADD COLUMN machine_id TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_sessions ADD COLUMN machine TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_sessions ADD COLUMN folder TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_sessions ADD COLUMN reason TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_sessions ADD COLUMN resets_at {{TS}};
ALTER TABLE agent_sessions ADD COLUMN item_seq {{BIGINT}} NOT NULL DEFAULT 0;
ALTER TABLE agent_sessions ADD COLUMN items_through {{BIGINT}} NOT NULL DEFAULT 0;
ALTER TABLE agent_sessions ADD COLUMN accepted_at {{TS}};
ALTER TABLE agent_sessions ADD COLUMN stop_requested_at {{TS}};
ALTER TABLE agent_sessions ADD COLUMN stop_requested_by {{ID}};
ALTER TABLE agent_sessions ADD COLUMN steps_dropped {{INT}} NOT NULL DEFAULT 0;
-- The runs open on one machine, which a page asks about ("queued behind a run").
CREATE INDEX agent_sessions_machine ON agent_sessions (workspace_id, machine_id, state);
-- What a runner says of itself when it holds an agent's listener of a
-- project: the machine, the folder's label, the program, and why it holds
-- back, if it does. Kept while another session holds the lease; cleared
-- when the runner lets the project go.
ALTER TABLE listeners ADD COLUMN machine_id TEXT;
ALTER TABLE listeners ADD COLUMN machine_name TEXT NOT NULL DEFAULT '';
ALTER TABLE listeners ADD COLUMN runner_folder TEXT NOT NULL DEFAULT '';
ALTER TABLE listeners ADD COLUMN runner_program TEXT NOT NULL DEFAULT '';
ALTER TABLE listeners ADD COLUMN runner_version TEXT NOT NULL DEFAULT '';
ALTER TABLE listeners ADD COLUMN runner_paused TEXT NOT NULL DEFAULT '';
ALTER TABLE listeners ADD COLUMN runner_paused_until {{TS}};
ALTER TABLE listeners ADD COLUMN runner_seen_at {{TS}};
-- The comment a run posted from its program's last message, when the agent
-- wrote nothing on the task itself.
ALTER TABLE comments ADD COLUMN session_id {{ID}};
