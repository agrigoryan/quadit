// Package webpush sends a notification to one browser by the Web Push
// standards: the message is encrypted for that browser alone (RFC 8291,
// aes128gcm) and the sender proves who it is with a token signed by its key
// (VAPID, RFC 8292). It hides the key format, the encryption and the
// signing behind Keys and Send; which browsers to send to, and the keys'
// keeping, are the caller's.
package webpush

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
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"golang.org/x/crypto/hkdf"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/plainjson"
)

// b64 is the base64 of Web Push: URL-safe, unpadded.
var b64 = base64.RawURLEncoding

// sendTimeout is how long a push service has to take a message.
const sendTimeout = 15 * time.Second

// Keys is a sender's key pair, as it is kept (the "push" setting).
type Keys struct {
	PublicKey  string `json:"public_key"`  // uncompressed P-256 point, base64url: what a browser subscribes with
	PrivateKey string `json:"private_key"` // the scalar, base64url
}

// NewKeys makes a key pair.
func NewKeys() (Keys, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return Keys{}, err
	}
	ek, err := key.ECDH()
	if err != nil {
		return Keys{}, err
	}
	return Keys{PublicKey: b64.EncodeToString(ek.PublicKey().Bytes()), PrivateKey: b64.EncodeToString(ek.Bytes())}, nil
}

// errDamagedKeys is a key pair that does not read, or whose halves do not
// belong together.
var errDamagedKeys = errors.New("the stored push key is damaged")

// Sender reads the private key, checking that the public half worked out
// from it is the one browsers were given.
func (k Keys) Sender() (*ecdsa.PrivateKey, error) {
	d, err := b64.DecodeString(k.PrivateKey)
	if err != nil {
		return nil, err
	}
	pub, err := b64.DecodeString(k.PublicKey)
	if err != nil || len(pub) != 65 || len(d) > 32 {
		return nil, errDamagedKeys
	}
	// The scalar is kept at its full 32 bytes; a shorter one is padded, as
	// a number it means the same.
	key, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), append(make([]byte, 32-len(d)), d...))
	if err != nil {
		return nil, errDamagedKeys
	}
	if ek, err := key.ECDH(); err != nil || !bytes.Equal(ek.PublicKey().Bytes(), pub) {
		return nil, errDamagedKeys
	}
	return key, nil
}

// Send encrypts payload for one browser's subscription and posts it to the
// browser's push service with hc, signed with key. subject is the sender's
// contact (an https address or mailto:; a stand-in is used for anything
// else). It returns the push service's status: 404 or 410 means the
// browser has unsubscribed. A push service is reached over HTTPS only.
func Send(ctx context.Context, hc *http.Client, key *ecdsa.PrivateKey, subject string, sub core.PushSubscription, payload []byte) (int, error) {
	ep, err := url.Parse(sub.Endpoint)
	if err != nil {
		return 0, err
	}
	if ep.Scheme != "https" {
		return 0, fmt.Errorf("a push service is reached over https, not at %s", ep.Redacted())
	}
	body, err := encrypt(sub.P256dh, sub.Auth, payload)
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
	ctx, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, sub.Endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("TTL", "86400")
	req.Header.Set("Urgency", "high")
	req.Header.Set("Authorization", "vapid t="+token+", k="+b64.EncodeToString(ek.PublicKey().Bytes()))
	resp, err := hc.Do(req)
	if err != nil {
		return 0, err
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096)) // drained only so the connection is reused; the status is the answer
	resp.Body.Close()
	return resp.StatusCode, nil
}

// vapidToken signs "this server may push to this endpoint's service".
func vapidToken(key *ecdsa.PrivateKey, audience, subject string) (string, error) {
	if !bytes.HasPrefix([]byte(subject), []byte("https://")) && !bytes.HasPrefix([]byte(subject), []byte("mailto:")) {
		subject = "mailto:admin@localhost" // push services want a contact; a local install has none to give
	}
	head := b64.EncodeToString([]byte(`{"typ":"JWT","alg":"ES256"}`))
	claims := plainjson.Marshal(map[string]any{"aud": audience, "exp": time.Now().Add(12 * time.Hour).Unix(), "sub": subject})
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

// encrypt seals a payload for one browser (RFC 8291, aes128gcm).
func encrypt(p256dh, authSecret string, payload []byte) ([]byte, error) {
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
