package server_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/url"
	"testing"

	"github.com/go-webauthn/webauthn/protocol/webauthncbor"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestAPasskeyCountsOnlyWhenItsDeviceCheckedWhoHoldsIt: a passkey is added,
// and signs in, only with a device that says it checked who holds it,
// whatever the ceremony was begun with: one begun before every ceremony
// asked for the check (its stored state says "preferred") is held to it
// when it is finished.
func TestAPasskeyCountsOnlyWhenItsDeviceCheckedWhoHoldsIt(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		dev := newPasskeyDevice(t)
		// begunBefore makes a ceremony's stored state what it was before every
		// ceremony asked for the check.
		begunBefore := func(t *testing.T, state string) {
			t.Helper()
			var spent core.OneTimeToken
			if err := st.Get(t.Context(), &spent, store.Eq("token_hash", auth.Hash(state))); err != nil {
				t.Fatal(err)
			}
			session := M{}
			if err := json.Unmarshal(spent.Data, &session); err != nil {
				t.Fatal(err)
			}
			session["userVerification"] = "preferred"
			if _, err := st.Update(t.Context(), "one_time_tokens", M{"data": session}, store.Eq("id", spent.ID)); err != nil {
				t.Fatal(err)
			}
		}

		register := func(t *testing.T, checked bool, want int) {
			t.Helper()
			var start struct {
				Options struct {
					PublicKey struct {
						Challenge string `json:"challenge"`
						User      struct {
							ID string `json:"id"`
						} `json:"user"`
					} `json:"publicKey"`
				} `json:"options"`
				State string `json:"state"`
			}
			s.in(t).call(s.owner, "", "POST", "/api/v1/auth/passkeys/register/start", M{}, 200, &start)
			begunBefore(t, start.State)
			dev.user = start.Options.PublicKey.User.ID
			s.in(t).call(s.owner, "", "POST", "/api/v1/auth/passkeys/register/finish?state="+url.QueryEscape(start.State),
				dev.made(t, s.url, start.Options.PublicKey.Challenge, checked), want, nil)
		}
		signIn := func(t *testing.T, checked bool, want int) {
			t.Helper()
			var start struct {
				Options struct {
					PublicKey struct {
						Challenge string `json:"challenge"`
					} `json:"publicKey"`
				} `json:"options"`
				State string `json:"state"`
			}
			s.in(t).call(nil, "", "POST", "/api/v1/auth/passkeys/login/start", M{}, 200, &start)
			begunBefore(t, start.State)
			s.in(t).call(browser(), "", "POST", "/api/v1/auth/passkeys/login/finish?state="+url.QueryEscape(start.State),
				dev.signed(t, s.url, start.Options.PublicKey.Challenge, checked), want, nil)
		}

		t.Run("added", func(t *testing.T) {
			register(t, false, 400)
			register(t, true, 201)
		})
		t.Run("signing in", func(t *testing.T) {
			signIn(t, false, 401)
			signIn(t, true, 200)
		})
	})
}

// passkeyDevice is a passkey device as a test plays it: one key, made for
// the person the server named, which says, or not, that it checked who
// holds it.
type passkeyDevice struct {
	key  *ecdsa.PrivateKey
	id   []byte
	user string // the person's handle, as the server gave it (base64url)
}

func newPasskeyDevice(t *testing.T) *passkeyDevice {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &passkeyDevice{key: key, id: []byte("a test passkey")}
}

// The flags of authenticator data: the person was there, the device
// checked who they are, a new key follows.
const (
	present  = 0x01
	verified = 0x04
	attested = 0x40
)

// authData is the authenticator data for origin's host, with flags, and
// the new key when attested is among them.
func (d *passkeyDevice) authData(t *testing.T, origin string, flags byte) []byte {
	u, _ := url.Parse(origin)
	rp := sha256.Sum256([]byte(u.Hostname()))
	out := append(rp[:], flags, 0, 0, 0, 0)
	if flags&attested == 0 {
		return out
	}
	out = append(out, make([]byte, 16)...) // no AAGUID
	out = binary.BigEndian.AppendUint16(out, uint16(len(d.id)))
	out = append(out, d.id...)
	pub, err := d.key.PublicKey.ECDH()
	if err != nil {
		t.Fatal(err)
	}
	point := pub.Bytes() // 0x04, x, y
	cose, err := webauthncbor.Marshal(map[int]any{1: 2, 3: -7, -1: 1, -2: point[1:33], -3: point[33:]})
	if err != nil {
		t.Fatal(err)
	}
	return append(out, cose...)
}

// presence is what a device says of the person signing: there, and checked
// when it checked who they are.
func presence(checked bool) byte {
	if checked {
		return present | verified
	}
	return present
}

func clientData(typ, challenge, origin string) []byte {
	raw, _ := json.Marshal(M{"type": typ, "challenge": challenge, "origin": origin, "crossOrigin": false})
	return raw
}

var b64 = base64.RawURLEncoding.EncodeToString

// made is the browser's answer to a request to make a passkey.
func (d *passkeyDevice) made(t *testing.T, origin, challenge string, checked bool) M {
	attestation, err := webauthncbor.Marshal(map[string]any{"fmt": "none", "attStmt": map[string]any{}, "authData": d.authData(t, origin, presence(checked)|attested)})
	if err != nil {
		t.Fatal(err)
	}
	return M{"id": b64(d.id), "rawId": b64(d.id), "type": "public-key", "response": M{
		"clientDataJSON": b64(clientData("webauthn.create", challenge, origin)), "attestationObject": b64(attestation)}}
}

// signed is the browser's answer to a request to sign in with the passkey.
func (d *passkeyDevice) signed(t *testing.T, origin, challenge string, checked bool) M {
	data := d.authData(t, origin, presence(checked))
	client := clientData("webauthn.get", challenge, origin)
	hash := sha256.Sum256(client)
	digest := sha256.Sum256(append(append([]byte{}, data...), hash[:]...))
	sig, err := ecdsa.SignASN1(rand.Reader, d.key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return M{"id": b64(d.id), "rawId": b64(d.id), "type": "public-key", "response": M{
		"clientDataJSON": b64(client), "authenticatorData": b64(data), "signature": b64(sig), "userHandle": d.user}}
}
