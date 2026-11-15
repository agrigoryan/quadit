// Helpers the reads share: request flags, list filters, files with their
// addresses, decisions in their named form, and who answers for an agent.

package server

import (
	"context"
	"net/url"
	"strings"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// truthyParam reports whether a flag parameter is given and on (see truthy).
func truthyParam(v url.Values, name string) bool {
	return v.Has(name) && truthy(v.Get(name))
}

// keep returns, in a new list, the items ok says yes to.
func keep[T any](list []T, ok func(T) bool) []T {
	out := make([]T, 0, len(list))
	for _, v := range list {
		if ok(v) {
			out = append(out, v)
		}
	}
	return out
}

// lines is items as text, one line each, or the line empty when there are none.
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

// fileURL is where a file is served, and its reduced copy when it has one.
func (who *viewer) fileURL(f core.File) (fileAddress, preview string) {
	fileAddress = who.baseURL + "/f/" + f.ID + "/" + url.PathEscape(f.Name)
	if f.PreviewKey != "" {
		preview = who.baseURL + "/f/" + f.ID + "/preview"
	}
	return fileAddress, preview
}

// attachments loads the attachments the conditions select (those of a task,
// of a page) with their files: as views by what each is attached to, and as
// rows, each with its file.
func (who *viewer) attachments(ctx context.Context, conds ...store.Cond) (map[string][]attachmentView, []core.Attachment, error) {
	var atts []core.Attachment
	if err := who.db.List(ctx, &atts, store.Q{Where: append(conds, store.Live), Order: "rank"}); err != nil {
		return nil, nil, err
	}
	ids := make([]string, len(atts))
	for i, a := range atts {
		ids[i] = a.FileID
	}
	var files []core.File
	if len(ids) > 0 {
		if err := who.db.List(ctx, &files, store.Where(store.In("id", ids))); err != nil {
			return nil, nil, err
		}
	}
	byID := map[string]core.File{}
	for _, f := range files {
		f.URL, f.PreviewURL = who.fileURL(f)
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

// decisionViews names decisions, numbering them within their task.
func (who *viewer) decisionViews(ctx context.Context, decisions []core.Decision) ([]decisionView, error) {
	return who.decisionViewsOf(ctx, decisions, false)
}

// decisionViewsWithFiles is decisionViews with the files on each question
// and on each option, and with how many comments each option has.
func (who *viewer) decisionViewsWithFiles(ctx context.Context, decisions []core.Decision) ([]decisionView, error) {
	return who.decisionViewsOf(ctx, decisions, true)
}

// decisionViewsOf names decisions, numbering each within its task and each
// option within its decision; withFiles adds the files and comment counts.
func (who *viewer) decisionViewsOf(ctx context.Context, decisions []core.Decision, withFiles bool) ([]decisionView, error) {
	if len(decisions) == 0 {
		return nil, nil
	}
	names, err := who.names(ctx)
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(decisions))
	onTask := map[string]bool{}
	for i, decision := range decisions {
		ids[i] = decision.ID
		onTask[decision.TaskID] = true
	}
	var taskIDs []string
	for taskID := range onTask {
		taskIDs = append(taskIDs, taskID)
	}
	var options []core.Option
	if err := who.db.List(ctx, &options, store.Q{Where: []store.Cond{store.In("decision_id", ids), store.Live}, Order: "rank"}); err != nil {
		return nil, err
	}

	// The files on the questions and the options (by decision or option id),
	// and the comments on each option.
	files := map[string][]attachmentView{}
	comments := map[string]int{}
	if withFiles {
		subjects := append([]string(nil), ids...)
		for _, option := range options {
			subjects = append(subjects, option.ID)
		}
		if files, _, err = who.attachments(ctx, store.In("subject_id", subjects)); err != nil {
			return nil, err
		}
		counts, err := who.db.Tally(ctx, "comments", []string{"subject_id"}, store.In("task_id", taskIDs), store.Eq("subject_type", "decision_option"), store.Live)
		if err != nil {
			return nil, err
		}
		for _, count := range counts {
			comments[count.Keys[0]] = count.Count
		}
	}

	keys := map[string]string{} // task key by task id
	tasks, err := who.db.Tasks(ctx, store.TaskFilter{IDs: taskIDs, Archived: true, Limit: maxTasksByID})
	if err != nil {
		return nil, err
	}
	for _, t := range tasks {
		keys[t.ID] = t.Key
	}

	ordinal := map[string]int{}
	out := make([]decisionView, len(decisions))
	for i, d := range decisions {
		ordinal[d.TaskID]++
		v := decisionView{N: ordinal[d.TaskID], ID: d.ID, Task: keys[d.TaskID], TaskID: d.TaskID, DeletedAt: d.DeletedAt, Kind: d.Kind, Question: d.Question, Details: d.Details, Action: d.Action,
			State: d.State, By: names.handle(d.CreatedBy), Asked: names.handle(d.AskedID), Recommendation: d.Recommendation, Outcome: d.Outcome,
			Note: d.OutcomeNote, DecidedBy: names.handle(d.DecidedBy), DecidedAt: formatTime(d.DecidedAt), UnclearNote: d.UnclearNote, AskedAt: formatTime(d.CreatedAt),
			Attachments: files[d.ID]}
		n := 0
		for _, o := range options {
			if o.DecisionID != d.ID {
				continue
			}
			n++
			v.Options = append(v.Options, optionView{N: n, ID: o.ID, Label: o.Label, Description: o.Description, Attachments: files[o.ID], Comments: comments[o.ID]})
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
// The lists it fills are shown without that when it cannot be read.
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
	responsible := map[string]string{}
	for _, user := range users {
		responsible[user.ID] = user.ResponsibleID
	}
	for i := range members {
		members[i].ResponsibleID = responsible[members[i].UserID]
	}
}
