package server

import (
	"fmt"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
)

// tasks writes tasks/: one readable file each.
func (e *exporter) tasks() error {
	e.indexTasks()
	for _, t := range e.rows.tasks {
		name := fmt.Sprintf("tasks/%s/%s %s.md", e.nm.projects[t.ProjectID].Key, t.Key, fileSafe(t.Title))
		if err := e.put(name, e.taskMarkdown(t)); err != nil {
			return err
		}
	}
	return nil
}

// indexTasks sorts out what the task files point at: each task's decisions
// and comments, each decision's options, the files on each task and option,
// and every task's key.
func (e *exporter) indexTasks() {
	e.optionsOf = map[string][]core.Option{}
	for _, o := range e.rows.options {
		e.optionsOf[o.DecisionID] = append(e.optionsOf[o.DecisionID], o)
	}
	e.decisionsOn = map[string][]core.Decision{}
	for _, d := range e.rows.decisions {
		e.decisionsOn[d.TaskID] = append(e.decisionsOn[d.TaskID], d)
	}
	e.commentsOn = map[string][]core.Comment{}
	for _, cm := range e.rows.comments {
		e.commentsOn[cm.TaskID] = append(e.commentsOn[cm.TaskID], cm)
	}
	fileOf := map[string]core.File{}
	for _, f := range e.rows.files {
		fileOf[f.ID] = f
	}
	e.filesOn = map[string][]string{}
	for _, a := range e.rows.atts {
		if f, ok := fileOf[a.FileID]; ok {
			e.filesOn[a.SubjectID] = append(e.filesOn[a.SubjectID], "files/"+f.ID+"/"+fileSafe(f.Name))
		}
	}
	e.keyOf = map[string]string{}
	for _, t := range e.rows.tasks {
		e.keyOf[t.ID] = t.Key
	}
}

// taskMarkdown is one task as a page: its fields, description, files,
// decisions and comments.
func (e *exporter) taskMarkdown(t core.Task) string {
	nm := e.nm
	var b strings.Builder
	e.taskFields(&b, t)
	fmt.Fprintf(&b, "---\n\n# %s\n\n%s\n", t.Title, t.Description)
	for _, f := range e.filesOn[t.ID] {
		fmt.Fprintf(&b, "\n- file: ../../%s", f)
	}
	for i, d := range e.decisionsOn[t.ID] {
		e.decisionMarkdown(&b, i+1, d)
	}
	for i, cm := range e.commentsOn[t.ID] {
		if i == 0 {
			b.WriteString("\n\n## Comments\n")
		}
		fmt.Fprintf(&b, "\n**%s**, %s", nm.handle(cm.AuthorID), when(cm.CreatedAt))
		if cm.Kind == "result" {
			b.WriteString(" (result)")
		}
		b.WriteString("\n\n" + cm.Body + "\n")
		if ev := cm.Evidence; ev != nil {
			fmt.Fprintf(&b, "\n- checked: %s\n- measured: %s\n- not verified: %s\n", ev.Checked, ev.Measured, ev.NotVerified)
		}
	}
	return b.String()
}

// taskFields writes the head of a task's page: its fields, one a line.
func (e *exporter) taskFields(b *strings.Builder, t core.Task) {
	nm := e.nm
	st := nm.statuses[t.StatusID]
	fmt.Fprintf(b, "---\nkey: %s\ntitle: %q\nstatus: %q\n", t.Key, t.Title, st.Name)
	if t.AssigneeID != "" {
		fmt.Fprintf(b, "assignee: %q\n", nm.handle(t.AssigneeID))
	}
	if t.WaitingOnID != "" {
		fmt.Fprintf(b, "waiting_on: %q\n", nm.handle(t.WaitingOnID))
	}
	if t.Priority > 0 {
		fmt.Fprintf(b, "priority: %s\n", priorityNames[t.Priority])
	}
	if ls := nm.labelNames(t.LabelIDs); len(ls) > 0 {
		fmt.Fprintf(b, "labels: [%s]\n", strings.Join(ls, ", "))
	}
	if ep, ok := nm.epics[t.EpicID]; ok {
		fmt.Fprintf(b, "epic: %q\n", ep.Name)
	}
	if t.ParentID != "" {
		fmt.Fprintf(b, "parent: %s\n", e.keyOf[t.ParentID])
	}
	if t.DueOn != "" {
		fmt.Fprintf(b, "due: %s\n", t.DueOn)
	}
	fmt.Fprintf(b, "created: %s\ncreated_by: %q\n", time.UnixMilli(t.CreatedAt).UTC().Format(time.RFC3339), nm.handle(t.CreatedBy))
	if t.CompletedAt != 0 {
		fmt.Fprintf(b, "completed: %s\n", time.UnixMilli(t.CompletedAt).UTC().Format(time.RFC3339))
	}
}

// decisionMarkdown writes one decision of a task, the n-th: the question,
// its options, who asked and what was answered.
func (e *exporter) decisionMarkdown(b *strings.Builder, n int, d core.Decision) {
	nm := e.nm
	fmt.Fprintf(b, "\n\n## Decision %d: %s\n\n", n, d.Question)
	if d.Details != "" {
		b.WriteString(d.Details + "\n\n")
	}
	for i, o := range e.optionsOf[d.ID] {
		mark := ""
		if o.ID == d.PickedOptionID {
			mark = " **(picked)**"
		} else if o.ID == d.RecommendedOptionID {
			mark = " (recommended)"
		}
		fmt.Fprintf(b, "%d. %s%s", i+1, o.Label, mark)
		if o.Description != "" {
			b.WriteString(": " + o.Description)
		}
		for _, f := range e.filesOn[o.ID] {
			fmt.Fprintf(b, " [file](../../%s)", f)
		}
		b.WriteString("\n")
	}
	fmt.Fprintf(b, "\nAsked by %s", nm.handle(d.CreatedBy))
	if d.AskedID != "" {
		b.WriteString(" of " + nm.handle(d.AskedID))
	}
	if d.Outcome != "" {
		fmt.Fprintf(b, ". Answer: %s by %s on %s", strings.ReplaceAll(d.Outcome, "_", " "), nm.handle(d.DecidedBy), when(d.DecidedAt))
		if d.OutcomeNote != "" {
			b.WriteString(": " + d.OutcomeNote)
		}
	}
	b.WriteString("\n")
}
