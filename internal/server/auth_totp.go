package server

// Two-step verification: authenticator codes and recovery codes.

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// checkSecond accepts an authenticator code or a recovery code.
func (s *Server) checkSecond(ctx context.Context, u core.User, code string) bool {
	code = strings.TrimSpace(code)
	if u.TOTPSecret == "" || code == "" {
		return false
	}
	secret, err := s.sealer.Open(u.TOTPSecret)
	if err != nil {
		return false
	}
	if step, ok := auth.CheckTOTP(secret, code, time.Now()); ok {
		// A code works once: remember the step it was used in.
		mark := core.OneTimeToken{ID: id.New(), Kind: core.OneTimeTOTPUsed, TokenHash: auth.Hash(fmt.Sprintf("totp:%s:%d", u.ID, step)), UserID: u.ID,
			CreatedAt: time.Now().UnixMilli(), ExpiresAt: time.Now().Add(5 * time.Minute).UnixMilli()}
		return s.st.Insert(ctx, mark) == nil
	}
	n, err := s.st.Update(ctx, "recovery_codes", map[string]any{"used_at": time.Now().UnixMilli()},
		store.Eq("user_id", u.ID), store.Eq("code_hash", auth.Hash(strings.ToLower(code))), store.Null("used_at"))
	return err == nil && n == 1
}

type codeBody struct {
	Code     string `json:"code"`
	Password string `json:"password"`
}

// handleFinishSecondStep finishes a sign-in that is waiting for its second step.
func (s *Server) handleFinishSecondStep(x *c) error {
	var b codeBody
	if err := x.body(&b); err != nil {
		return err
	}
	if x.sess == nil || x.sess.Stage == core.SessionFull {
		return x.ok(map[string]any{"user": x.user})
	}
	ctx := x.ctx()
	if err := s.throttle(ctx, "mfa:"+x.user.ID, 8, signInWindow); err != nil {
		return err
	}
	if !s.checkSecond(ctx, x.user, b.Code) {
		s.audit(x.r, "", x.user, "signin.second_step_failed", "user", x.user.ID, nil)
		return errUnauthorized("that code is not right; codes change every 30 seconds")
	}
	if _, err := s.st.Update(ctx, "sessions", map[string]any{"stage": core.SessionFull}, store.Eq("id", x.sess.ID)); err != nil {
		return err
	}
	s.audit(x.r, "", x.user, "signin", "user", x.user.ID, map[string]string{"method": "password+code"})
	return x.ok(map[string]any{"user": x.user})
}

// handleStartTwoStepSetup makes a new secret for the person to add to their app. It is
// not in force until they prove the app works with handleEnableTwoStep.
func (s *Server) handleStartTwoStepSetup(x *c) error {
	if x.sess == nil {
		return errForbidden("two-step verification is set up by its person, signed in")
	}
	if x.user.TOTPAt != 0 {
		return &engine.Error{Code: engine.CodeConflict, Message: "two-step verification is already on; turn it off first to set up a new app"}
	}
	secret := auth.NewTOTPSecret()
	sealed, err := s.sealer.Seal(secret)
	if err != nil {
		return err
	}
	if _, err := s.st.Update(x.ctx(), "users", map[string]any{"totp_secret": sealed}, store.Eq("id", x.user.ID)); err != nil {
		return err
	}
	issuer := s.installName(x.ctx())
	return x.ok(map[string]any{"secret": secret, "url": auth.TOTPURL(issuer, x.user.Email, secret)})
}

func (s *Server) newRecoveryCodes(ctx context.Context, userID string) ([]string, error) {
	codes := auth.NewRecoveryCodes()
	err := s.st.Atomic(ctx, func(db store.DB) error {
		if _, err := db.Delete(ctx, "recovery_codes", store.Eq("user_id", userID)); err != nil {
			return err
		}
		for _, code := range codes {
			if err := db.Insert(ctx, core.RecoveryCode{ID: id.New(), UserID: userID, CodeHash: auth.Hash(code), CreatedAt: time.Now().UnixMilli()}); err != nil {
				return err
			}
		}
		return nil
	})
	return codes, err
}

// handleEnableTwoStep turns two-step verification on once a code from the app
// checks out, and returns the recovery codes, shown this once.
func (s *Server) handleEnableTwoStep(x *c) error {
	var b codeBody
	if err := x.body(&b); err != nil {
		return err
	}
	ctx := x.ctx()
	if x.sess == nil || x.user.TOTPSecret == "" || x.user.TOTPAt != 0 {
		return errBad("start the setup first")
	}
	secret, err := s.sealer.Open(x.user.TOTPSecret)
	if err != nil {
		return err
	}
	if _, ok := auth.CheckTOTP(secret, b.Code, time.Now()); !ok {
		return &engine.Error{Code: engine.CodeInvalid, Field: "code", Message: "that code is not right; check the time on your phone and try the next code"}
	}
	if _, err := s.st.Update(ctx, "users", map[string]any{"totp_at": time.Now().UnixMilli()}, store.Eq("id", x.user.ID)); err != nil {
		return err
	}
	codes, err := s.newRecoveryCodes(ctx, x.user.ID)
	if err != nil {
		return err
	}
	s.audit(x.r, "", x.user, "second_step.enabled", "user", x.user.ID, nil)
	return x.ok(map[string]any{"recovery_codes": codes})
}

// handleDisableTwoStep turns two-step verification off, confirmed with a
// current code or the password.
func (s *Server) handleDisableTwoStep(x *c) error {
	var b codeBody
	if err := x.body(&b); err != nil {
		return err
	}
	ctx := x.ctx()
	if x.sess == nil {
		return errForbidden("two-step verification is changed by its person, signed in")
	}
	if !s.checkSecond(ctx, x.user, b.Code) && (x.user.PasswordHash == "" || !auth.CheckPassword(x.user.PasswordHash, b.Password)) {
		return &engine.Error{Code: engine.CodeForbidden, Field: "code", Message: "confirm with a current code or your password"}
	}
	if err := s.secondStepNotRequired(ctx, x.user); err != nil {
		return err
	}
	if _, err := s.st.Update(ctx, "users", map[string]any{"totp_at": 0, "totp_secret": ""}, store.Eq("id", x.user.ID)); err != nil {
		return err
	}
	// Without the app's secret the codes let nobody in; they go on the
	// next setup if not now.
	if _, err := s.st.Delete(ctx, "recovery_codes", store.Eq("user_id", x.user.ID)); err != nil {
		s.log.Warn("recovery codes not removed with two-step verification", "err", err)
	}
	s.audit(x.r, "", x.user, "second_step.disabled", "user", x.user.ID, nil)
	return x.ok(map[string]any{"ok": true})
}

// secondStepNotRequired refuses turning codes off where the install requires
// a second step and the person has no passkey to be it.
func (s *Server) secondStepNotRequired(ctx context.Context, u core.User) error {
	required, err := s.checkedSettingBool(ctx, "auth.require_2fa", false)
	if err != nil || !required {
		return err
	}
	passkeys, err := s.st.Count(ctx, "passkeys", store.Eq("user_id", u.ID))
	if err != nil {
		return err
	}
	if passkeys == 0 {
		return errForbidden("this install requires two-step verification; add a passkey before turning codes off")
	}
	return nil
}

// handleRenewRecoveryCodes replaces the recovery codes with ten new ones.
func (s *Server) handleRenewRecoveryCodes(x *c) error {
	var b codeBody
	if err := x.body(&b); err != nil {
		return err
	}
	if x.sess == nil || x.user.TOTPAt == 0 {
		return errBad("two-step verification is not on")
	}
	if !s.checkSecond(x.ctx(), x.user, b.Code) {
		return &engine.Error{Code: engine.CodeForbidden, Field: "code", Message: "confirm with a current code"}
	}
	codes, err := s.newRecoveryCodes(x.ctx(), x.user.ID)
	if err != nil {
		return err
	}
	return x.ok(map[string]any{"recovery_codes": codes})
}
