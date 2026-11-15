package server

// LimitFactor is how far the request limits are scaled from their defaults
// (1 = the defaults), for tests.
func (s *Server) LimitFactor() float64 {
	s.limits.mu.Lock()
	defer s.limits.mu.Unlock()
	return s.limits.factor
}
