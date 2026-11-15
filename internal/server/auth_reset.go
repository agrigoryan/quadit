package server

// Resetting a forgotten password with a mailed link.

import (
	"context"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

type resetRequestBody struct {
	Email string `json:"email"`
}

// handleRequestPasswordReset mails a reset link. The answer is the same whether or not
// the address has an account, so it tells an outsider nothing.
func (s *Server) handleRequestPasswordReset(x *c) error {
	var b resetRequestBody
	if err := x.body(&b); err != nil {
		return err
	}
	ctx := x.ctx()
	if err := s.throttle(ctx, "reset:ip:"+clientIP(x.r), accountRequestsPerHour, time.Hour); err != nil {
		return err
	}
	if !s.mailReady(ctx) {
		return &httpError{Status: 409, Code: "no_mail", Message: "this install has no mail server; ask whoever runs it to reset your password with: quadit admin reset-password <email>"}
	}
	email := strings.ToLower(strings.TrimSpace(b.Email))
	var u core.User
	there, err := store.Find(ctx, s.st, &u, store.Eq("email", email), store.Live)
	if err != nil {
		return err
	}
	if there && u.Kind == core.KindPerson && u.DisabledAt == 0 {
		token, err := s.oneTime(ctx, core.OneTimeReset, u.ID, nil, time.Hour)
		if err != nil {
			return err
		}
		link := s.cfg.BaseURL + "/reset/" + token
		s.detach(ctx, func(ctx context.Context) {
			if err := s.sendMail(ctx, u.Email, "Reset your password",
				"Someone asked to reset the password for this address.\n\nOpen this link within an hour to choose a new one:\n"+link+
					"\n\nIf it was not you, ignore this message; nothing has changed."); err != nil {
				s.log.Error("reset mail", "err", err)
			}
		})
		s.audit(x.r, "", u, "password.reset_requested", "user", u.ID, nil)
	}
	return x.ok(map[string]any{"ok": true})
}

type resetConfirmBody struct {
	Token    string `json:"token"`
	Password string `json:"password"`
}

// handleConfirmPasswordReset sets a new password with a mailed reset link,
// and signs the person out everywhere.
func (s *Server) handleConfirmPasswordReset(x *c) error {
	var b resetConfirmBody
	if err := x.body(&b); err != nil {
		return err
	}
	ctx := x.ctx()
	if err := auth.CheckPasswordRules(b.Password); err != nil {
		return &engine.Error{Code: engine.CodeInvalid, Field: "password", Message: err.Error()}
	}
	spent, err := s.useOneTime(ctx, core.OneTimeReset, b.Token, false)
	if err != nil {
		return err
	}
	hash, err := auth.HashPassword(b.Password)
	if err != nil {
		return err
	}
	if err := s.setPassword(ctx, spent.UserID, hash); err != nil {
		return err
	}
	s.accessChanged()
	s.audit(x.r, "", core.User{ID: spent.UserID}, "password.reset", "user", spent.UserID, nil)
	return x.ok(map[string]any{"ok": true})
}
