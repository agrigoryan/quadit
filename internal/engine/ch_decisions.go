// decision.*: open, update, pick, unclear, delete and restore.

package engine

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/rank"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	register("decision.open", core.RoleMember, decisionOpen)
	register("decision.update", core.RoleMember, decisionUpdate)
	register("decision.pick", core.RoleMember, decisionPick)
	register("decision.unclear", core.RoleMember, decisionUnclear)
	register("decision.delete", core.RoleMember, decisionDelete)
	register("decision.restore", core.RoleMember, decisionRestore)
}

type optionArgs struct {
	ID          string       `json:"id"`
	Label       string       `json:"label"`
	Description string       `json:"description"`
	Attachments []attachArgs `json:"attachments"`
}

type decisionOpenArgs struct {
	ID       string       `json:"id"`
	Task     string       `json:"task" quadit:"required,handler"`
	Kind     string       `json:"kind"` // choice (default when options are given) or approval
	Question string       `json:"question" quadit:"required,handler"`
	Details  string       `json:"details"`
	Options  []optionArgs `json:"options"`
	// Recommended is the option the asker would pick: its position in
	// options starting at 1, or its id.
	Recommended    any    `json:"recommended"`
	Recommendation string `json:"recommendation"`
	// Ask is who should answer. The task then waits on them. An agent that
	// names nobody asks the person responsible for it.
	Ask string `json:"ask"`
	// Action, on an approval, is the change type the asker wants to make,
	// and Args the arguments it will be sent with. The approval then covers
	// exactly that change, once.
	Action string          `json:"action"`
	Args   json.RawMessage `json:"args"`
}

func (c *cx) loadOptions(d *core.Decision) error {
	return c.tx.List(c.ctx, &d.Options, store.Q{Where: []store.Cond{store.Eq("decision_id", d.ID), store.Live}, Order: "rank"})
}

// decisionOpen asks a question on a task: a choice between options, or an
// approval. The one asked is told, and the task waits on them.
func decisionOpen(c *cx, a decisionOpenArgs) error {
	did, err := newID("id", a.ID)
	if err != nil {
		return err
	}
	t, err := c.task("task", a.Task)
	if err != nil {
		return err
	}
	if strings.TrimSpace(a.Question) == "" {
		return invalid("question", "a decision needs a question")
	}
	kind, err := decisionKind(a)
	if err != nil {
		return err
	}
	asked, err := c.askedOf(a, kind, t)
	if err != nil {
		return err
	}
	d := core.Decision{ID: did, WorkspaceID: c.ws, TaskID: t.ID, Kind: kind, Question: strings.TrimSpace(a.Question), Details: a.Details,
		Action: a.Action, ActionArgs: a.Args, State: core.StateOpen, AskedID: asked, Recommendation: a.Recommendation,
		CreatedBy: c.actor.UserID, CreatedAt: c.at, UpdatedAt: c.at}
	if err := c.newOptions(&d, a); err != nil {
		return err
	}
	if err := c.insertDecision(&d, t, a); err != nil {
		return err
	}
	if asked == "" {
		return nil
	}
	return c.putQuestion(d, t)
}

// decisionKind is the kind of a new decision, the one given or the one its
// options imply, checked against what that kind takes.
func decisionKind(a decisionOpenArgs) (string, error) {
	kind := a.Kind
	if kind == "" {
		kind = core.DecisionChoice
		if len(a.Options) == 0 {
			kind = core.DecisionApproval
		}
	}
	switch kind {
	case core.DecisionChoice:
		if len(a.Options) < 2 {
			return "", invalid("options", "a choice needs at least two options; for a plain yes or no use kind \"approval\"")
		}
	case core.DecisionApproval:
		if len(a.Options) > 0 {
			return "", invalid("options", "an approval has no options: it is answered approved or declined")
		}
		if a.Action != "" {
			if _, ok := handlers[a.Action]; !ok {
				return "", oneOf("action", "change type", a.Action, ChangeTypes())
			}
			var args map[string]any
			if len(a.Args) == 0 || json.Unmarshal(a.Args, &args) != nil || len(args) == 0 {
				return "", invalid("args", "say what exactly is to be approved: args are the arguments %s will be sent with, e.g. {\"id\": \"SVA-12\"}. The approval covers that change and no other", a.Action)
			}
		} else if len(a.Args) > 0 {
			return "", invalid("args", "args go with an action")
		}
	default:
		return "", oneOf("kind", "kind", kind, []string{core.DecisionChoice, core.DecisionApproval})
	}
	return kind, nil
}

// askedOf is who a new decision is put to: the member named, or for an
// agent that names nobody, the person responsible for it. Either is held
// to personOnTask's rule: one who cannot read the task's project is not
// asked.
func (c *cx) askedOf(a decisionOpenArgs, kind string, t core.Task) (string, error) {
	asked := ""
	if a.Ask != "" {
		var err error
		if asked, err = c.personOnTask("ask", a.Ask, t); err != nil {
			return "", err
		}
		if asked == c.actor.UserID {
			return "", invalid("ask", "you cannot ask yourself: someone else has to answer")
		}
	} else if c.actor.Kind == core.KindAgent {
		var self core.User
		if err := c.tx.Get(c.ctx, &self, store.Eq("id", c.actor.UserID)); err != nil {
			return "", err
		}
		asked = self.ResponsibleID
		var responsible core.Member
		there, err := store.Find(c.ctx, c.tx, &responsible, store.Eq("user_id", self.ResponsibleID), store.Null("removed_at"))
		if err != nil {
			return "", err
		}
		if there && !responsible.Scope.MayRead(t.ProjectID) {
			return "", invalid("ask", "@%s, who answers for you, cannot read this task's project, so they cannot be asked about it: name someone who can with ask", responsible.Handle)
		}
	}
	if kind == core.DecisionApproval && a.Action != "" && asked != "" {
		m, err := c.memberRef("ask", asked)
		if err != nil && !isRefusal(err) {
			return "", err
		}
		if err == nil && m.Kind != core.KindPerson {
			return "", invalid("ask", "an approval for a change is asked of a person; @%s is an agent", m.Handle)
		}
	}
	return asked, nil
}

// newOptions gives a new decision its options, and marks the one the asker
// recommends.
func (c *cx) newOptions(d *core.Decision, a decisionOpenArgs) error {
	seen := map[string]bool{}
	for i, o := range a.Options {
		oid, err := newID("options.id", o.ID)
		if err != nil {
			return err
		}
		if seen[oid] {
			return invalid("options", "two options share the id %s", oid)
		}
		seen[oid] = true
		if strings.TrimSpace(o.Label) == "" {
			return invalid("options", "option %d needs a label", i+1)
		}
		d.Options = append(d.Options, core.Option{ID: oid, WorkspaceID: c.ws, DecisionID: d.ID, Label: strings.TrimSpace(o.Label),
			Description: o.Description, Rank: rank.ForNumber(i + 1), CreatedAt: c.at})
	}
	switch r := a.Recommended.(type) {
	case nil:
	case float64:
		if r < 1 || int(r) > len(d.Options) {
			return invalid("recommended", "recommended is the position of an option, 1 to %d, or its id", len(d.Options))
		}
		d.RecommendedOptionID = d.Options[int(r)-1].ID
	case string:
		if !seen[r] {
			return invalid("recommended", "the recommended option is not one of the options")
		}
		d.RecommendedOptionID = r
	default:
		return invalid("recommended", "recommended is the position of an option, or its id")
	}
	return nil
}

// insertDecision writes a new decision with its options and their files,
// and says so in the task's feed and to search.
func (c *cx) insertDecision(d *core.Decision, t core.Task, a decisionOpenArgs) error {
	// Decisions keep the order they were asked in.
	n, err := c.tx.Count(c.ctx, "decisions", store.Eq("task_id", t.ID))
	if err != nil {
		return err
	}
	d.Rank = rank.ForNumber(n + 1)
	seq := c.tx.NextSeq()
	d.CreatedSeq, d.UpdatedSeq = seq, seq
	if err := c.tx.Insert(c.ctx, *d); err != nil {
		return alreadyInUse(err, "id", d.ID)
	}
	var atts []core.Attachment
	for i, o := range d.Options {
		if err := c.tx.Insert(c.ctx, o); err != nil {
			return alreadyInUse(err, "option id", o.ID)
		}
		for _, aa := range a.Options[i].Attachments {
			at, err := c.attach(aa, "decision_option", o.ID, t)
			if err != nil {
				return err
			}
			atts = append(atts, at)
		}
	}
	if err := c.touchTask(t.ID, seq); err != nil {
		return err
	}
	data := core.EventData{Row: *d, Key: &t.Key, Attachments: atts}
	c.ref, c.key = d.ID, t.Key
	if err := c.emit(event{seq: seq, typ: "decision.opened", entity: "decision", entityID: d.ID, place: inTask(t), data: data}); err != nil {
		return err
	}
	if err := c.watch(c.actor.UserID, "task", t.ID); err != nil {
		return err
	}
	return c.index(store.SearchDoc{Kind: "decision", EntityID: d.ID, ScopeType: "task", ScopeID: t.ID, ProjectID: t.ProjectID, Title: d.Question, Body: decisionText(d.Details, d.Options)})
}

// putQuestion puts a new decision to the one who should answer it: they
// follow the task, are told, and the task waits on them.
func (c *cx) putQuestion(d core.Decision, t core.Task) error {
	asked := d.AskedID
	if err := c.watch(asked, "task", t.ID); err != nil {
		return err
	}
	if err := c.notifyTask(asked, core.NoteAsked, t, about{entity: "decision", id: d.ID, text: d.Question}); err != nil {
		return err
	}
	// A closed task waits on nobody; the question still reaches its inbox.
	var st core.Status
	ok, err := store.Find(c.ctx, c.tx, &st, store.Eq("id", t.StatusID))
	if err != nil {
		return err
	}
	if ok && !core.OpenCategory(st.Category) {
		return nil
	}
	return c.setWaitingOn(t, asked, "answer: "+snippet(d.Question, 80))
}

type decisionUpdateArgs struct {
	ID             string      `json:"id" quadit:"required"`
	Question       Opt[string] `json:"question"`
	Details        Opt[string] `json:"details"`
	Recommendation Opt[string] `json:"recommendation"`
	Recommended    Opt[string] `json:"recommended"` // an option id
}

// decisionTask loads a decision, named by its id or by its task ("SVA-7",
// "SVA-7#2"), and the task it is on.
func (c *cx) decisionTask(ref string) (core.Decision, core.Task, error) {
	if ref != "" && !looksLikeID(ref) {
		// By its task: "SVA-7" is that task's one open decision, "SVA-7#2"
		// its second decision in the order they were asked.
		id, err := c.decisionOnTask(ref)
		if err != nil {
			return core.Decision{}, core.Task{}, err
		}
		ref = id
	}
	d, err := loadLive[core.Decision](c, "decision", "id", ref)
	if err != nil {
		return d, core.Task{}, err
	}
	if err := c.loadOptions(&d); err != nil {
		return d, core.Task{}, err
	}
	t, err := c.task("id", d.TaskID)
	return d, t, err
}

// decisionUpdate changes an open decision, by the one who asked it.
func decisionUpdate(c *cx, a decisionUpdateArgs) error {
	d, t, err := c.decisionTask(a.ID)
	if err != nil {
		return err
	}
	if d.CreatedBy != c.actor.UserID && !c.actor.Role.AtLeast(core.RoleAdmin) {
		return forbidden("only the one who asked can edit a decision")
	}
	if d.State != core.StateOpen {
		return conflictErr("this decision was already answered; open a new one to ask again")
	}
	p := newPatch()
	if err := p.name("question", a.Question, &d.Question); err != nil {
		return err
	}
	p.setText("details", a.Details, &d.Details)
	p.setText("recommendation", a.Recommendation, &d.Recommendation)
	if a.Recommended.Set {
		if !a.Recommended.Null && !hasOption(d, a.Recommended.V) {
			return &Error{Code: CodeInvalid, Field: "recommended", Message: "recommended must be one of this decision's options", Allowed: optionIDs(d)}
		}
		p.setText("recommended_option_id", a.Recommended, &d.RecommendedOptionID)
	}
	if !p.empty() {
		p.set["updated_at"] = c.at
	}
	if err := c.save(p, target{table: "decisions", entity: "decision", id: d.ID, place: inTask(t), extra: core.EventData{Key: &t.Key}}); err != nil {
		return err
	}
	return c.touchTask(t.ID, c.tx.Seq())
}

type decisionPickArgs struct {
	ID string `json:"id" quadit:"required"`
	// Option is the option picked: its id, its position starting at 1, or
	// its label.
	Option  any    `json:"option"`
	Outcome string `json:"outcome"`
	Note    string `json:"note"`
}

// decisionPick answers a decision: an option of a choice, with or without
// changes, or approved or declined for an approval; or sends it back. The
// asker is told, and the task goes back to them.
func decisionPick(c *cx, a decisionPickArgs) error {
	before := c.tx.Seq()
	d, t, err := c.decisionTask(a.ID)
	if err != nil {
		return err
	}
	if err := c.mayAnswer(d); err != nil {
		return err
	}
	optionID, err := pickedOption(d, a.Option)
	if err != nil {
		return err
	}
	outcome, state, err := pickOutcome(d, a, optionID)
	if err != nil {
		return err
	}
	seq := c.tx.NextSeq()
	answer := map[string]any{"state": state, "picked_option_id": optionID, "outcome": outcome,
		"outcome_note": a.Note, "decided_by": c.actor.UserID, "decided_at": c.at, "unclear_note": "", "updated_at": c.at, "updated_seq": seq}
	if d.Kind == core.DecisionApproval && d.Action != "" && !c.system {
		// The approval reaches what its giver reaches now, through the
		// credential they answer with too: checkApproval holds the change to
		// it. Every project is an empty list, never NULL, which is an answer
		// whose reach is unknown.
		reach := c.scope.Projects
		if reach == nil {
			reach = []string{}
		}
		answer["approver_projects"] = reach
	}
	if _, err := c.tx.Update(c.ctx, "decisions", answer, store.Eq("id", d.ID)); err != nil {
		return err
	}
	d.State, d.PickedOptionID, d.Outcome, d.OutcomeNote, d.DecidedBy, d.DecidedAt, d.UpdatedSeq, d.UnclearNote = state, optionID, outcome, a.Note, c.actor.UserID, c.at, seq, ""
	if err := c.touchTask(t.ID, seq); err != nil {
		return err
	}
	c.ref, c.key = d.ID, t.Key
	if err := c.emit(event{seq: seq, typ: "decision.picked", entity: "decision", entityID: d.ID, place: inTask(t), data: core.EventData{Row: d, Key: &t.Key}}); err != nil {
		return err
	}
	// Answered, the question asks nothing of anyone any more; and the one
	// who answered has acted on the task.
	if err := c.readQuestion(d); err != nil {
		return err
	}
	if err := c.readWrittenOn(t.ID, before); err != nil {
		return err
	}
	if err := c.watch(c.actor.UserID, "task", t.ID); err != nil {
		return err
	}
	text := outcome
	for _, o := range d.Options {
		if o.ID == optionID {
			text = o.Label
		}
	}
	if a.Note != "" {
		text += ": " + a.Note
	}
	// The answer is in, so the next move is the asker's.
	if err := c.notifyTask(d.CreatedBy, core.NotePicked, t, about{entity: "decision", id: d.ID, text: text}); err != nil {
		return err
	}
	if _, err := c.memberRef("id", d.CreatedBy); isRefusal(err) {
		return nil // the asker left the workspace
	} else if err != nil {
		return err
	}
	// Other open questions on the task keep it with whoever must answer them.
	if n, err := c.tx.Count(c.ctx, "decisions", store.Eq("task_id", t.ID), store.Eq("state", core.StateOpen), store.Live,
		store.Eq("asked_id", c.actor.UserID)); err != nil || n > 0 {
		return err
	}
	return c.setWaitingOn(t, d.CreatedBy, "answered: "+snippet(text, 80))
}

// mayAnswer says whether the actor may answer a decision.
func (c *cx) mayAnswer(d core.Decision) error {
	// The first answer stands. A second one is refused, not merged.
	if d.State != core.StateOpen {
		return conflictErr("this decision was already answered (%s); open a new one to ask again", d.State)
	}
	if d.CreatedBy == c.actor.UserID {
		return forbidden("you asked this question, so someone else has to answer it")
	}
	if d.Kind == core.DecisionApproval && d.Action != "" && !c.system {
		// An approval for a change is given by a person who could make the
		// change, and, when it was asked of someone, by them. Whether the
		// approver reaches what the change touches is held when it is used
		// (checkApproval).
		if c.actor.Kind != core.KindPerson {
			return forbidden("an approval for a change is a person's to give, not an agent's")
		}
		if d.AskedID != "" && d.AskedID != c.actor.UserID {
			return forbidden("this approval was asked of someone else; only they can give it")
		}
		if h, ok := handlers[d.Action]; ok && !c.actor.Role.AtLeast(h.min) {
			return forbidden("%s needs the %s role, so a %s cannot approve it", d.Action, h.min, c.actor.Role)
		}
	}
	if c.actor.Kind == core.KindAgent && d.AskedID != "" && d.AskedID != c.actor.UserID {
		return forbidden("this question was asked of someone else")
	}
	return nil
}

// pickedOption is the id of the option an answer names: by its position
// starting at 1, its id or its label. Naming none gives "".
func pickedOption(d core.Decision, option any) (string, error) {
	optionID := ""
	switch o := option.(type) {
	case nil:
	case float64:
		if o < 1 || int(o) > len(d.Options) {
			return "", invalid("option", "option is a position, 1 to %d, an option id or a label", len(d.Options))
		}
		optionID = d.Options[int(o)-1].ID
	case string:
		for _, opt := range d.Options {
			if opt.ID == o || strings.EqualFold(opt.Label, o) {
				optionID = opt.ID
			}
		}
		// A position written as text ("2") is a position still.
		if n, err := strconv.Atoi(strings.TrimSpace(o)); optionID == "" && err == nil && n >= 1 && n <= len(d.Options) {
			optionID = d.Options[n-1].ID
		}
		if optionID == "" && o != "" {
			labels := make([]string, len(d.Options))
			for i, opt := range d.Options {
				labels[i] = opt.Label
			}
			return "", &Error{Code: CodeInvalid, Field: "option", Message: "that is not one of this decision's options", Allowed: labels, Nearest: nearest(o, labels)}
		}
	default:
		return "", invalid("option", "option is a position, an option id or a label")
	}
	return optionID, nil
}

// pickOutcome works out how a decision is answered and the state that
// leaves it in: picked, or sent back to the asker.
func pickOutcome(d core.Decision, a decisionPickArgs, optionID string) (outcome, state string, err error) {
	if d.Kind == core.DecisionApproval {
		return approvalOutcome(a.Outcome, optionID)
	}
	return choiceOutcome(d, a, optionID)
}

// approvalOutcome is pickOutcome for an approval: approved, or declined
// and sent back.
func approvalOutcome(outcome, optionID string) (string, string, error) {
	if optionID != "" {
		return "", "", invalid("option", "an approval has no options")
	}
	switch outcome {
	case core.OutcomeApproved:
		return outcome, core.StatePicked, nil
	case core.OutcomeDeclined:
		return outcome, core.StateSentBack, nil
	}
	return "", "", &Error{Code: CodeInvalid, Field: "outcome", Message: "an approval is answered approved or declined",
		Allowed: []string{core.OutcomeApproved, core.OutcomeDeclined}}
}

// choiceOutcome is pickOutcome for a choice: an option as it is or with
// changes, or none and sent back.
func choiceOutcome(d core.Decision, a decisionPickArgs, optionID string) (string, string, error) {
	outcome := a.Outcome
	if outcome == "" && optionID != "" {
		outcome = core.OutcomeAsIs
		if strings.TrimSpace(a.Note) != "" {
			outcome = core.OutcomeWithChanges
		}
	}
	switch outcome {
	case core.OutcomeAsIs, core.OutcomeWithChanges:
		if optionID == "" {
			return "", "", &Error{Code: CodeInvalid, Field: "option", Message: "say which option: its position, id or label", Allowed: optionIDs(d)}
		}
		if outcome == core.OutcomeWithChanges && strings.TrimSpace(a.Note) == "" {
			return "", "", invalid("note", "\"with_changes\" needs a note saying what to change")
		}
		return outcome, core.StatePicked, nil
	case core.OutcomeNone:
		if optionID != "" {
			return "", "", invalid("option", "outcome \"none\" picks no option")
		}
		return outcome, core.StateSentBack, nil
	}
	return "", "", &Error{Code: CodeInvalid, Field: "outcome", Message: "a choice is answered with an option, or sent back",
		Allowed: []string{core.OutcomeAsIs, core.OutcomeWithChanges, core.OutcomeNone}}
}

type decisionUnclearArgs struct {
	ID   string `json:"id" quadit:"required"`
	Note string `json:"note" quadit:"required,handler"` // what is unclear, in one line
}

// decisionUnclear is the asker saying the answer does not settle the
// question. The decision opens again and goes back to whoever answered.
func decisionUnclear(c *cx, a decisionUnclearArgs) error {
	before := c.tx.Seq()
	d, t, err := c.decisionTask(a.ID)
	if err != nil {
		return err
	}
	if d.CreatedBy != c.actor.UserID {
		return forbidden("only the one who asked can say the answer is unclear")
	}
	if d.State == core.StateOpen {
		return conflictErr("this decision has no answer yet")
	}
	if strings.TrimSpace(a.Note) == "" {
		return invalid("note", "say in one line what is unclear")
	}
	answerer := d.DecidedBy
	seq := c.tx.NextSeq()
	if _, err := c.tx.Update(c.ctx, "decisions", map[string]any{"state": core.StateOpen, "unclear_note": a.Note, "asked_id": answerer,
		"picked_option_id": "", "outcome": "", "outcome_note": "", "decided_by": "", "decided_at": 0, "updated_at": c.at, "updated_seq": seq}, store.Eq("id", d.ID)); err != nil {
		return err
	}
	prev := core.Answer{PickedOptionID: d.PickedOptionID, Outcome: d.Outcome, OutcomeNote: d.OutcomeNote, DecidedBy: d.DecidedBy}
	d.State, d.UnclearNote, d.AskedID, d.PickedOptionID, d.Outcome, d.OutcomeNote, d.DecidedBy, d.DecidedAt, d.UpdatedSeq = core.StateOpen, a.Note, answerer, "", "", "", "", 0, seq
	if err := c.touchTask(t.ID, seq); err != nil {
		return err
	}
	c.ref, c.key = d.ID, t.Key
	if err := c.emit(event{seq: seq, typ: "decision.unclear", entity: "decision", entityID: d.ID, place: inTask(t), data: core.EventData{Row: d, Key: &t.Key, Previous: &prev}}); err != nil {
		return err
	}
	if err := c.notifyTask(answerer, core.NoteUnclear, t, about{entity: "decision", id: d.ID, text: a.Note}); err != nil {
		return err
	}
	if err := c.readWrittenOn(t.ID, before); err != nil {
		return err
	}
	return c.setWaitingOn(t, answerer, "unclear: "+snippet(a.Note, 80))
}

func decisionDelete(c *cx, a idArgs) error {
	d, t, err := c.decisionTask(a.ID)
	if err != nil {
		return err
	}
	if d.CreatedBy != c.actor.UserID && !c.actor.Role.AtLeast(core.RoleAdmin) {
		return forbidden("only the one who asked, or an admin, can delete a decision")
	}
	if err := c.tx.Unindex(c.ctx, d.ID); err != nil {
		return err
	}
	if err := c.trash(target{table: "decisions", entity: "decision", id: d.ID, place: inTask(t), extra: core.EventData{Key: &t.Key}}); err != nil {
		return err
	}
	// Taken back, the question asks nothing of anyone any more.
	if err := c.readQuestion(d); err != nil {
		return err
	}
	return c.touchTask(t.ID, c.tx.Seq())
}

// decisionRestore takes a decision back out of the trash, as it was.
func decisionRestore(c *cx, a idArgs) error {
	var d core.Decision
	if a.ID == "" {
		return invalid("id", "id is required")
	}
	if err := c.tx.Get(c.ctx, &d, store.Eq("id", a.ID)); err != nil {
		return missing(err, "decision", a.ID)
	}
	t, err := c.anyTask("id", d.TaskID)
	if err != nil {
		return err
	}
	c.ref, c.key = d.ID, t.Key
	if d.DeletedAt == 0 {
		return nil // not in the trash: nothing to do
	}
	if t.DeletedAt != 0 {
		return conflictErr("%s is in the trash; restore the task first", t.Key)
	}
	if d.CreatedBy != c.actor.UserID && !c.actor.Role.AtLeast(core.RoleAdmin) {
		return forbidden("only the one who asked, or an admin, can restore a decision")
	}
	seq := c.tx.NextSeq()
	if _, err := c.tx.Update(c.ctx, "decisions", map[string]any{"deleted_at": int64(0), "updated_seq": seq}, store.Eq("id", d.ID)); err != nil {
		return err
	}
	d.DeletedAt, d.UpdatedSeq = 0, seq
	if err := c.loadOptions(&d); err != nil {
		return err
	}
	if err := c.index(store.SearchDoc{Kind: "decision", EntityID: d.ID, ScopeType: "task", ScopeID: t.ID, ProjectID: t.ProjectID, Title: d.Question, Body: decisionText(d.Details, d.Options)}); err != nil {
		return err
	}
	if err := c.touchTask(t.ID, seq); err != nil {
		return err
	}
	// The whole decision goes out again: a copy that dropped it has it back.
	return c.emit(event{seq: seq, typ: "decision.restored", entity: "decision", entityID: d.ID, place: inTask(t), data: core.EventData{Row: d, Key: &t.Key}})
}

func hasOption(d core.Decision, optionID string) bool {
	for _, o := range d.Options {
		if o.ID == optionID {
			return optionID != ""
		}
	}
	return false
}

func optionIDs(d core.Decision) []string {
	out := make([]string, len(d.Options))
	for i, o := range d.Options {
		out[i] = o.ID
	}
	return out
}

// decisionOnTask resolves "KEY" or "KEY#N" to a decision's id.
func (c *cx) decisionOnTask(ref string) (string, error) {
	key, nth, numbered := strings.Cut(ref, "#")
	t, err := c.task("id", key)
	if err != nil {
		return "", err
	}
	var ds []core.Decision
	if err := c.tx.List(c.ctx, &ds, store.Q{Where: []store.Cond{store.Eq("task_id", t.ID), store.Live}, Order: "created_at"}); err != nil {
		return "", err
	}
	if numbered {
		n, err := strconv.Atoi(nth)
		if err != nil || n < 1 || n > len(ds) {
			return "", invalid("id", "%s has %d decisions; %q is not one of them", t.Key, len(ds), ref)
		}
		return ds[n-1].ID, nil
	}
	var open []core.Decision
	for _, d := range ds {
		if d.State == core.StateOpen {
			open = append(open, d)
		}
	}
	switch {
	case len(open) == 1:
		return open[0].ID, nil
	case len(ds) == 1:
		return ds[0].ID, nil
	case len(ds) == 0:
		return "", invalid("id", "%s has no decisions", t.Key)
	}
	return "", invalid("id", "%s has %d decisions, %d of them open; say which with %s#1, %s#2, …", t.Key, len(ds), len(open), t.Key, t.Key)
}

// decisionText is what search finds a decision by besides its question:
// its details, and each option's label and description, a line each.
func decisionText(details string, options []core.Option) string {
	var b strings.Builder
	b.WriteString(details)
	for _, o := range options {
		b.WriteString("\n" + o.Label + " " + o.Description)
	}
	return b.String()
}
