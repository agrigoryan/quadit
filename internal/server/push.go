package server

import (
	"context"
	"crypto/ecdsa"
	"net/url"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/plainjson"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/webpush"
)

// Browser push: the install's key, the browsers people turned push on in,
// and sending to them. The protocol (RFC 8291, VAPID) is package webpush.
// No outside service is involved beyond the browser maker's own push
// endpoint, and only for people who turned push on.

// pushRoutes are the routes of push notifications to a browser.
func (s *Server) pushRoutes() []route {
	return []route{
		{"GET /api/v1/push/key", s.signedIn(s.handleShowPushKey), "The key a browser needs to subscribe to push notifications.", "", "account"},
		{"POST /api/v1/push/subscriptions", s.signedIn(s.handleSubscribeToPush), "Register this browser for push. Body: the browser's subscription {endpoint, keys}.", "", "account"},
		{"DELETE /api/v1/push/subscriptions", s.signedIn(s.handleUnsubscribeFromPush), "Stop push to this browser. Body: {endpoint}.", "", "account"},
		{"POST /api/v1/push/test", s.signedIn(s.handleSendTestNotification), "Send a test notification to this account's browsers.", "", "account"},
	}
}

// pushKey returns the install's push key pair, as the "push" setting keeps
// it, making it on first use, and its private key.
func (s *Server) pushKey(ctx context.Context) (webpush.Keys, *ecdsa.PrivateKey, error) {
	var pk webpush.Keys
	s.setting(ctx, "push", &pk)
	if pk.PrivateKey == "" {
		made, err := webpush.NewKeys()
		if err != nil {
			return pk, nil, err
		}
		pk = made
		raw := plainjson.Marshal(pk)
		if err := s.saveSetting(ctx, "push", raw, ""); err != nil {
			return pk, nil, err
		}
	}
	key, err := pk.Sender()
	return pk, key, err
}

// handleShowPushKey answers with the public key browsers subscribe with.
func (s *Server) handleShowPushKey(x *c) error {
	pk, _, err := s.pushKey(x.ctx())
	if err != nil {
		return err
	}
	return x.ok(map[string]any{"public_key": pk.PublicKey})
}

// pushSubBody is a browser's subscription as its own toJSON() gives it.
type pushSubBody struct {
	Endpoint string `json:"endpoint"`
	// ExpirationTime is part of what browsers send (null in practice). It
	// is taken and not used: a subscription that ends is dropped when the
	// push service says it is gone.
	ExpirationTime any `json:"expirationTime"`
	Keys           struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

// handleSubscribeToPush remembers a browser that agreed to receive push.
func (s *Server) handleSubscribeToPush(x *c) error {
	var b pushSubBody
	if err := x.body(&b); err != nil {
		return err
	}
	u, err := url.Parse(b.Endpoint)
	if err != nil || u.Scheme != "https" || b.Keys.P256dh == "" || b.Keys.Auth == "" {
		return errBad("that is not a push subscription")
	}
	ua := x.r.UserAgent()
	if len(ua) > 200 {
		ua = ua[:200]
	}
	sub := core.PushSubscription{ID: id.New(), UserID: x.user.ID, Endpoint: b.Endpoint, P256dh: b.Keys.P256dh, Auth: b.Keys.Auth, UserAgent: ua, CreatedAt: time.Now().UnixMilli()}
	if err := s.st.Upsert(x.ctx(), sub, "endpoint"); err != nil {
		return err
	}
	return x.json(201, map[string]any{"ok": true})
}

// handleUnsubscribeFromPush forgets a browser of the caller's.
func (s *Server) handleUnsubscribeFromPush(x *c) error {
	var b pushSubBody
	if err := x.body(&b); err != nil {
		return err
	}
	if _, err := s.st.Delete(x.ctx(), "push_subscriptions", store.Eq("endpoint", b.Endpoint), store.Eq("user_id", x.user.ID)); err != nil {
		return err
	}
	return x.ok(map[string]any{"ok": true})
}

// handleSendTestNotification pushes a sample message to the caller's browsers.
func (s *Server) handleSendTestNotification(x *c) error {
	n, err := s.pushTo(x.ctx(), x.user.ID, pushMessage{Title: "Push works", Body: "This is what a notification looks like.", URL: "/"})
	if err != nil {
		return err
	}
	if n == 0 {
		have, err := s.st.Count(x.ctx(), "push_subscriptions", store.Eq("user_id", x.user.ID))
		if err != nil {
			return err
		}
		if have > 0 {
			return &httpError{Status: 502, Code: "push_failed", Message: "your browser's push service did not take the message; the server log says why"}
		}
		return errBad("no browser of yours has push turned on")
	}
	return x.ok(map[string]any{"sent": n})
}

// pushMessage is what the service worker shows.
type pushMessage struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url"`
	Tag   string `json:"tag,omitempty"`
}

// pushTo sends a message to every browser a person turned push on in, and
// forgets browsers that have gone away.
func (s *Server) pushTo(ctx context.Context, userID string, msg pushMessage) (int, error) {
	var subs []core.PushSubscription
	if err := s.st.List(ctx, &subs, store.Where(store.Eq("user_id", userID))); err != nil || len(subs) == 0 {
		return 0, err
	}
	_, key, err := s.pushKey(ctx)
	if err != nil {
		return 0, err
	}
	payload := plainjson.Marshal(msg)
	sent := 0
	for _, sub := range subs {
		status, err := webpush.Send(ctx, key, s.cfg.BaseURL, sub, payload)
		switch {
		case err != nil:
			s.log.Warn("push", "err", err)
		case status == 404 || status == 410:
			// The browser unsubscribed. One not forgotten now is on the next push.
			if _, err := s.st.Delete(ctx, "push_subscriptions", store.Eq("id", sub.ID)); err != nil {
				s.log.Warn("push: forgetting a browser that unsubscribed", "err", err)
			}
		case status >= 200 && status < 300:
			sent++
		default:
			s.log.Warn("push refused", "status", status)
		}
	}
	return sent, nil
}
