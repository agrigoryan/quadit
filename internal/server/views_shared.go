package server

import (
	"context"
	"net/url"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

func truthyParam(v url.Values, name string) bool {
	return v.Has(name) && truthy(v.Get(name))
}

func keep[T any](list []T, ok func(T) bool) []T {
	out := make([]T, 0, len(list))
	for _, v := range list {
		if ok(v) {
			out = append(out, v)
		}
	}
	return out
}

func lines[T any](items []T, line func(T) string, empty string) string {
	if len(items) == 0 {
		return empty + "\n"
	}
	var b strings.Builder
	for _, it := range items {
		b.WriteString(line(it) + "\n")
	}
	return b.String()
}

func (x *c) fileURL(f core.File) (string, string) {
	u := x.s.cfg.BaseURL + "/f/" + f.ID + "/" + url.PathEscape(f.Name)
	preview := ""
	if f.PreviewKey != "" {
		preview = x.s.cfg.BaseURL + "/f/" + f.ID + "/preview"
	}
	return u, preview
}

// attachments loads the attachments in a task with their files, by subject.
func (x *c) attachments(conds ...store.Cond) (map[string][]attachmentView, []core.Attachment, error) {
	var atts []core.Attachment
	if err := x.db.List(x.ctx(), &atts, store.Q{Where: append(conds, store.Live), Order: "rank"}); err != nil {
		return nil, nil, err
	}
	ids := make([]string, len(atts))
	for i, a := range atts {
		ids[i] = a.FileID
	}
	var files []core.File
	if len(ids) > 0 {
		if err := x.db.List(x.ctx(), &files, store.Where(store.In("id", ids))); err != nil {
			return nil, nil, err
		}
	}
	byID := map[string]core.File{}
	for _, f := range files {
		f.URL, f.PreviewURL = x.fileURL(f)
		byID[f.ID] = f
	}
	out := map[string][]attachmentView{}
	for i, a := range atts {
		f := byID[a.FileID]
		atts[i].File = &f
		out[a.SubjectID] = append(out[a.SubjectID], attachmentView{ID: a.ID, Name: f.Name, Type: f.ContentType, Size: f.Size, URL: f.URL,
			Preview: f.PreviewURL, Role: a.Role, Caption: a.Caption})
	}
	return out, atts, nil
}

// decisionViews names decisions, numbering them within their task. With
// files, each comes with the files on its question and on each option, and
// each option with how many comments it has.
func (x *c) decisionViews(ds []core.Decision, withFiles bool) ([]decisionView, error) {
	if len(ds) == 0 {
		return nil, nil
	}
	names, err := x.names()
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(ds))
	taskIDs := map[string]bool{}
	for i, d := range ds {
		ids[i] = d.ID
		taskIDs[d.TaskID] = true
	}
	var opts []core.Option
	if err := x.db.List(x.ctx(), &opts, store.Q{Where: []store.Cond{store.In("decision_id", ids), store.Live}, Order: "rank"}); err != nil {
		return nil, err
	}
	files := map[string][]attachmentView{}
	counts := map[string]int{}
	var tids []string
	for t := range taskIDs {
		tids = append(tids, t)
	}
	if withFiles {
		subjects := append([]string(nil), ids...)
		for _, o := range opts {
			subjects = append(subjects, o.ID)
		}
		if files, _, err = x.attachments(store.In("subject_id", subjects)); err != nil {
			return nil, err
		}
		rows, err := x.db.Tally(x.ctx(), "comments", []string{"subject_id"}, store.In("task_id", tids), store.Eq("subject_type", "decision_option"), store.Live)
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			counts[r.Keys[0]] = r.Count
		}
	}
	keys := map[string]string{}
	ts, err := x.db.Tasks(x.ctx(), store.TaskFilter{IDs: tids, Archived: true, Limit: 5000})
	if err != nil {
		return nil, err
	}
	for _, t := range ts {
		keys[t.ID] = t.Key
	}
	ordinal := map[string]int{}
	out := make([]decisionView, len(ds))
	for i, d := range ds {
		ordinal[d.TaskID]++
		v := decisionView{N: ordinal[d.TaskID], ID: d.ID, Task: keys[d.TaskID], TaskID: d.TaskID, DeletedAt: d.DeletedAt, Kind: d.Kind, Question: d.Question, Details: d.Details, Action: d.Action,
			State: d.State, By: names.handle(d.CreatedBy), Asked: names.handle(d.AskedID), Recommendation: d.Recommendation, Outcome: d.Outcome,
			Note: d.OutcomeNote, DecidedBy: names.handle(d.DecidedBy), DecidedAt: formatTime(d.DecidedAt), UnclearNote: d.UnclearNote, AskedAt: formatTime(d.CreatedAt),
			Attachments: files[d.ID]}
		n := 0
		for _, o := range opts {
			if o.DecisionID != d.ID {
				continue
			}
			n++
			v.Options = append(v.Options, optionView{N: n, ID: o.ID, Label: o.Label, Description: o.Description, Attachments: files[o.ID], Comments: counts[o.ID]})
			if o.ID == d.RecommendedOptionID {
				v.Recommended = n
			}
			if o.ID == d.PickedOptionID {
				v.Picked, v.PickedLabel = n, o.Label
			}
		}
		out[i] = v
	}
	return out, nil
}

// withResponsible fills in, for each agent, the person who answers for it.
func (s *Server) withResponsible(ctx context.Context, members []core.Member) {
	var ids []string
	for _, m := range members {
		if m.Kind == core.KindAgent {
			ids = append(ids, m.UserID)
		}
	}
	if len(ids) == 0 {
		return
	}
	var users []core.User
	if err := s.st.List(ctx, &users, store.Where(store.In("id", ids))); err != nil {
		s.log.Warn("agents listed without who answers for them", "err", err)
		return
	}
	by := map[string]string{}
	for _, u := range users {
		by[u.ID] = u.ResponsibleID
	}
	for i := range members {
		members[i].ResponsibleID = by[members[i].UserID]
	}
}
