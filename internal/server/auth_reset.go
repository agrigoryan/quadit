package server

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
	if err := s.throttle(ctx, "reset:ip:"+clientIP(x.r), 10, time.Hour); err != nil {
		return err
	}
	if !s.mailReady(ctx) {
		return &httpError{Status: 409, Code: "no_mail", Message: "this install has no mail server; ask whoever runs it to reset your password with: quadit admin reset-password <email>"}
	}
	email := strings.ToLower(strings.TrimSpace(b.Email))
	var u core.User
	if err := s.st.Get(ctx, &u, store.Eq("email", email), store.Live); err == nil && u.Kind == core.KindPerson && u.DisabledAt == 0 {
		token, err := s.oneTime(ctx, "reset", u.ID, nil, time.Hour)
		if err != nil {
			return err
		}
		link := s.cfg.BaseURL + "/reset/" + token
		go func() {
			if err := s.sendMail(context.Background(), u.Email, "Reset your password",
				"Someone asked to reset the password for this address.\n\nOpen this link within an hour to choose a new one:\n"+link+
					"\n\nIf it was not you, ignore this message; nothing has changed."); err != nil {
				s.log.Error("reset mail", "err", err)
			}
		}()
		s.audit(x.r, "", u, "password.reset_requested", "user", u.ID, nil)
	}
	return x.ok(map[string]any{"ok": true})
}

type resetConfirmBody struct {
	Token    string `json:"token"`
	Password string `json:"password"`
}

func (s *Server) handleConfirmPasswordReset(x *c) error {
	var b resetConfirmBody
	if err := x.body(&b); err != nil {
		return err
	}
	ctx := x.ctx()
	if err := auth.CheckPasswordRules(b.Password); err != nil {
		return &engine.Error{Code: engine.CodeInvalid, Field: "password", Message: err.Error()}
	}
	ot, err := s.useOneTime(ctx, "reset", b.Token, false)
	if err != nil {
		return err
	}
	hash, err := auth.HashPassword(b.Password)
	if err != nil {
		return err
	}
	if _, err := s.st.Update(ctx, "users", map[string]any{"password_hash": hash}, store.Eq("id", ot.UserID)); err != nil {
		return err
	}
	s.st.Update(ctx, "sessions", map[string]any{"revoked_at": time.Now().UnixMilli()}, store.Eq("user_id", ot.UserID), store.Null("revoked_at"))
	s.accessChanged()
	s.audit(x.r, "", core.User{ID: ot.UserID}, "password.reset", "user", ot.UserID, nil)
	return x.ok(map[string]any{"ok": true})
}
