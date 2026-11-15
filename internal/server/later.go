package server

import (
	"net/http"
)

// moreRoutes registers the routes added by other files of this package.
func (s *Server) moreRoutes(m *http.ServeMux) {
	for _, add := range extraRoutes {
		add(s, m)
	}
}

// extraRoutes lets each feature file add its routes from an init function.
var extraRoutes []func(s *Server, m *http.ServeMux)
