package server

import (
	"encoding/json"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
)

// POST /changes: the one way to write, and what of it goes in the audit log.

// changesBody is the body of POST /changes: a batch, or one change.
type changesBody struct {
	Changes []engine.Change `json:"changes"`
	DryRun  bool            `json:"dry_run"`
	// A single change may be sent bare, without the changes list: it is
	// read as one, with every field a change in the list has.
	engine.Change
}

// auditedPrefixes are the change types that go in the audit log: those that
// change who may do what, and those that remove a lot at once.
var auditedPrefixes = []string{"member.", "agent.", "project.delete", "webhook.", "rule.", "integration.", "secret.", "workspace.update", "workspace.delete"}

// auditArgs is a change's arguments as the audit log keeps them: what was
// asked, with anything secret blanked out.
func auditArgs(raw json.RawMessage) any {
	var args map[string]json.RawMessage
	if json.Unmarshal(raw, &args) != nil {
		return nil
	}
	for _, k := range []string{"secret", "value", "password", "token", "credentials", "private_key"} {
		if v, ok := args[k]; ok && string(v) != `""` && string(v) != "null" {
			args[k] = json.RawMessage(`"•••"`)
		}
	}
	return args
}

// handleApplyChanges applies one change or a batch. A batch is all or nothing.
// dry_run checks without writing; events=1 (or a dry run) answers with the
// events each change made. Changes of the audited kinds, and every use of
// an approval, are written to the audit log.
func (s *Server) handleApplyChanges(x *c) error {
	var b changesBody
	if err := x.body(&b); err != nil {
		return err
	}
	if len(b.Changes) == 0 && b.Type != "" {
		b.Changes = []engine.Change{b.Change}
	}
	dry := b.DryRun || truthyParam(x.r.URL.Query(), "dry_run")
	res, err := s.eng.Batch(x.ctx(), x.ws.ID, x.actor, b.Changes, dry)
	if err != nil {
		return err
	}
	withEvents := truthyParam(x.r.URL.Query(), "events") || dry
	var seq int64
	for i, r := range res {
		if r.Seq > seq {
			seq = r.Seq
		}
		if dry || r.Duplicate {
			continue
		}
		for _, p := range auditedPrefixes {
			if strings.HasPrefix(r.Type, p) {
				s.audit(x.r, x.ws.ID, x.user, r.Type, strings.SplitN(r.Type, ".", 2)[0], r.Ref, auditArgs(b.Changes[i].Args))
			}
		}
		if b.Changes[i].Approval != "" {
			s.audit(x.r, x.ws.ID, x.user, "approval.used", "decision", b.Changes[i].Approval, map[string]string{"change": r.Type})
		}
	}
	for _, r := range res {
		if !withEvents {
			r.Events = nil
			continue
		}
		// The sender gets back what its change did, less what was written
		// for someone else alone (a notice in another member's inbox).
		r.Events = keep(r.Events, func(ev core.Event) bool { return ev.AudienceID == "" || ev.AudienceID == x.member.UserID })
	}
	if !dry && len(res) > 0 {
		last := res[len(res)-1]
		s.touchPresence(x, strings.TrimSpace(last.Type+" "+last.Key))
	}
	out := map[string]any{"results": res, "seq": seq}
	if dry {
		out["dry_run"] = true
	}
	return x.ok(out)
}
