package server

import (
	"context"
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

// providerList names the outside sign-in providers that are turned on.
var providerList0 = func(s *Server, ctx context.Context) []map[string]string { return []map[string]string{} }

func (s *Server) providerList(ctx context.Context) []map[string]string { return providerList0(s, ctx) }
