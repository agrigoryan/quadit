package server

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"golang.org/x/crypto/hkdf"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// Browser push follows the Web Push standards: the message is encrypted for
// the one browser (RFC 8291) and the server proves who it is with a signed
// token (VAPID, RFC 8292). No outside service is involved beyond the
// browser maker's own push endpoint, and only for people who turned push on.

func init() {
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("GET /api/v1/push/key", s.signedIn(s.handleShowPushKey))
		m.HandleFunc("POST /api/v1/push/subscriptions", s.signedIn(s.handleSubscribeToPush))
		m.HandleFunc("DELETE /api/v1/push/subscriptions", s.signedIn(s.handleUnsubscribeFromPush))
		m.HandleFunc("POST /api/v1/push/test", s.signedIn(s.handleSendTestNotification))
	})
}

// b64 is the base64 of Web Push: URL-safe, unpadded.
var b64 = base64.RawURLEncoding

// pushKeys is the install's push key pair, as the "push" setting keeps it.
type pushKeys struct {
	PublicKey  string `json:"public_key"`  // uncompressed P-256 point, base64url
	PrivateKey string `json:"private_key"` // the scalar, base64url
}

// pushKey returns the install's push key pair, making it on first use.
func (s *Server) pushKey(ctx context.Context) (pushKeys, *ecdsa.PrivateKey, error) {
	var pk pushKeys
	s.setting(ctx, "push", &pk)
	if pk.PrivateKey == "" {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return pk, nil, err
		}
		ek, err := key.ECDH()
		if err != nil {
			return pk, nil, err
		}
		pk = pushKeys{PublicKey: b64.EncodeToString(ek.PublicKey().Bytes()), PrivateKey: b64.EncodeToString(ek.Bytes())}
		raw, _ := json.Marshal(pk) // two strings: always encodes
		if err := s.saveSetting(ctx, "push", raw, ""); err != nil {
			return pk, nil, err
		}
	}
	d, err := b64.DecodeString(pk.PrivateKey)
	if err != nil {
		return pk, nil, err
	}
	pub, err := b64.DecodeString(pk.PublicKey)
	if err != nil || len(pub) != 65 || len(d) > 32 {
		return pk, nil, errors.New("the stored push key is damaged")
	}
	// The scalar is kept at its full 32 bytes; a shorter one is padded, as
	// a number it means the same.
	key, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), append(make([]byte, 32-len(d)), d...))
	if err != nil {
		return pk, nil, errors.New("the stored push key is damaged")
	}
	// The public half is worked out from the scalar: it must be the one
	// browsers were given.
	if ek, err := key.ECDH(); err != nil || !bytes.Equal(ek.PublicKey().Bytes(), pub) {
		return pk, nil, errors.New("the stored push key is damaged")
	}
	return pk, key, nil
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
	payload, _ := json.Marshal(msg) // strings: always encodes
	sent := 0
	for _, sub := range subs {
		status, err := sendPush(ctx, key, s.cfg.BaseURL, sub, payload)
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

// sendPush encrypts and posts one message to one browser.
func sendPush(ctx context.Context, key *ecdsa.PrivateKey, subject string, sub core.PushSubscription, payload []byte) (int, error) {
	body, err := encryptPush(sub.P256dh, sub.Auth, payload)
	if err != nil {
		return 0, err
	}
	ep, err := url.Parse(sub.Endpoint)
	if err != nil {
		return 0, err
	}
	token, err := vapidToken(key, ep.Scheme+"://"+ep.Host, subject)
	if err != nil {
		return 0, err
	}
	ek, err := key.ECDH()
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, sub.Endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("TTL", "86400")
	req.Header.Set("Urgency", "high")
	req.Header.Set("Authorization", "vapid t="+token+", k="+b64.EncodeToString(ek.PublicKey().Bytes()))
	hc := http.Client{Timeout: 15 * time.Second}
	resp, err := hc.Do(req)
	if err != nil {
		return 0, err
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096)) //nolint:errcheck // drained only so the connection is reused; the status is the answer
	resp.Body.Close()
	return resp.StatusCode, nil
}

// vapidToken signs "this server may push to this endpoint's service".
func vapidToken(key *ecdsa.PrivateKey, audience, subject string) (string, error) {
	if !bytes.HasPrefix([]byte(subject), []byte("https://")) && !bytes.HasPrefix([]byte(subject), []byte("mailto:")) {
		subject = "mailto:admin@localhost" // push services want a contact; a local install has none to give
	}
	head := b64.EncodeToString([]byte(`{"typ":"JWT","alg":"ES256"}`))
	claims, _ := json.Marshal(map[string]any{"aud": audience, "exp": time.Now().Add(12 * time.Hour).Unix(), "sub": subject})
	signing := head + "." + b64.EncodeToString(claims)
	sum := sha256.Sum256([]byte(signing))
	r, sgn, err := ecdsa.Sign(rand.Reader, key, sum[:])
	if err != nil {
		return "", err
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	sgn.FillBytes(sig[32:])
	return signing + "." + b64.EncodeToString(sig), nil
}

// decodeKey reads a browser's key, unpadded or padded.
func decodeKey(s string) ([]byte, error) {
	if raw, err := b64.DecodeString(s); err == nil {
		return raw, nil
	}
	return base64.StdEncoding.DecodeString(s) // some browsers pad
}

// hkdfExpand derives n bytes from secret, salt and info (HKDF with SHA-256).
func hkdfExpand(secret, salt, info []byte, n int) ([]byte, error) {
	out := make([]byte, n)
	if _, err := io.ReadFull(hkdf.New(sha256.New, secret, salt, info), out); err != nil {
		return nil, err
	}
	return out, nil
}

// encryptPush seals a payload for one browser (RFC 8291, aes128gcm).
func encryptPush(p256dh, authSecret string, payload []byte) ([]byte, error) {
	uaPub, err := decodeKey(p256dh)
	if err != nil {
		return nil, fmt.Errorf("subscription key: %w", err)
	}
	auth, err := decodeKey(authSecret)
	if err != nil {
		return nil, fmt.Errorf("subscription secret: %w", err)
	}
	curve := ecdh.P256()
	ua, err := curve.NewPublicKey(uaPub)
	if err != nil {
		return nil, fmt.Errorf("subscription key: %w", err)
	}
	as, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	shared, err := as.ECDH(ua)
	if err != nil {
		return nil, err
	}
	asPub := as.PublicKey().Bytes()
	info := append(append([]byte("WebPush: info\x00"), uaPub...), asPub...)
	ikm, err := hkdfExpand(shared, auth, info, 32)
	if err != nil {
		return nil, err
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	cek, err := hkdfExpand(ikm, salt, []byte("Content-Encoding: aes128gcm\x00"), 16)
	if err != nil {
		return nil, err
	}
	nonce, err := hkdfExpand(ikm, salt, []byte("Content-Encoding: nonce\x00"), 12)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	sealed := gcm.Seal(nil, nonce, append(append([]byte{}, payload...), 0x02), nil) // 0x02 ends the last record
	var out bytes.Buffer
	out.Write(salt)
	out.Write(binary.BigEndian.AppendUint32(nil, 4096)) // the record size
	out.WriteByte(byte(len(asPub)))
	out.Write(asPub)
	out.Write(sealed)
	return out.Bytes(), nil
}
