-- Agent-run rows are durable execution traces. Ephemeral agents are deleted
-- after their tasks finish; their historical run attribution must survive.
DO $$
DECLARE item record;
BEGIN
  IF to_regclass('project.agent_runs') IS NULL OR to_regclass('project.agents') IS NULL THEN
    RETURN; -- Old baseline replay may not have created these tables yet.
  END IF;
  FOR item IN
    SELECT constraint_name.conname
    FROM pg_constraint AS constraint_name
    WHERE constraint_name.conrelid = 'project.agent_runs'::regclass
      AND constraint_name.confrelid = 'project.agents'::regclass
      AND constraint_name.contype = 'f'
  LOOP
    EXECUTE format('ALTER TABLE project.agent_runs DROP CONSTRAINT %I', item.conname);
  END LOOP;
END $$;

-- Keep write-time admission while allowing historical rows to outlive the
-- agent. The row lock makes a simultaneous agent deletion wait for admission.
CREATE OR REPLACE FUNCTION project.guard_active_agent_run() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'active' THEN
    PERFORM 1 FROM project.agents
    WHERE project_id = NEW.project_id AND id = NEW.agent_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'agent_run requires an existing agent for active work'
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Explicit and automatic ephemeral-agent retirement must not leave a run
-- marked active. Historical agentId and terminal run data remain readable.
CREATE OR REPLACE FUNCTION project.terminate_runs_on_agent_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE ended text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  UPDATE project.agent_runs
  SET status = 'terminated', ended_at = ended,
      data = jsonb_set(jsonb_set(data, '{status}', '"terminated"'::jsonb, true),
                       '{endedAt}', to_jsonb(ended), true)
  WHERE project_id = OLD.project_id AND agent_id = OLD.id AND status = 'active';
  RETURN OLD;
END $$;

DO $$
BEGIN
  IF to_regclass('project.agent_runs') IS NULL OR to_regclass('project.agents') IS NULL THEN
    RETURN; -- Reapply after legacy baseline tables are materialized.
  END IF;
  DROP TRIGGER IF EXISTS guard_active_agent_run ON project.agent_runs;
  CREATE TRIGGER guard_active_agent_run BEFORE INSERT OR UPDATE ON project.agent_runs
    FOR EACH ROW EXECUTE FUNCTION project.guard_active_agent_run();
  DROP TRIGGER IF EXISTS terminate_runs_on_agent_delete ON project.agents;
  CREATE TRIGGER terminate_runs_on_agent_delete BEFORE DELETE ON project.agents
    FOR EACH ROW EXECUTE FUNCTION project.terminate_runs_on_agent_delete();
END $$;
