package server

import "net/http"

func init() {
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("GET /api/v1/events/types", s.open(func(x *c) error { return x.ok(map[string]any{"types": eventTypes}) }))
	})
}

// eventTypes lists the kinds of event the feed carries, for pickers in
// webhook and rule forms. A family can be chosen whole as "task.*".
var eventTypes = []string{
	"task.created", "task.updated", "task.restored",
	"comment.created", "comment.updated", "comment.deleted",
	"decision.opened", "decision.picked", "decision.unclear", "decision.updated", "decision.deleted",
	"attachment.created", "attachment.deleted", "relation.created", "relation.deleted", "link.created", "link.updated", "link.deleted",
	"project.created", "project.updated", "project.deleted", "status.created", "status.updated", "status.deleted",
	"label.created", "label.updated", "label.deleted",
	"epic.created", "epic.updated", "epic.deleted", "milestone.created", "milestone.updated", "milestone.deleted",
	"cycle.created", "cycle.updated", "cycle.deleted", "view.created", "view.updated", "view.deleted",
	"template.created", "template.updated", "template.deleted", "preference.created", "preference.updated", "preference.deleted",
	"member.created", "member.updated", "workspace.updated",
	"doc.created", "doc.updated", "doc.edited", "doc.deleted", "doc.restored",
	"property.created", "property.updated", "property.deleted", "dbview.created", "dbview.updated", "dbview.deleted",
	"session.created", "session.updated", "resource.created", "resource.deleted", "claim.created", "claim.updated",
	"webhook.created", "webhook.updated", "webhook.deleted", "rule.created", "rule.updated", "rule.deleted",
	"integration.created", "integration.updated", "integration.deleted", "source.created", "source.updated", "source.deleted",
	"notification.created", "notification.updated",
}
