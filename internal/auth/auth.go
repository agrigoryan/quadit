// Package auth holds the credential primitives: password hashes, random
// tokens and their stored hashes, and sealing secrets at rest.
//
//	auth.go   passwords, tokens and the Sealer
//	totp.go   two-step codes (TOTP)
package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"testing"

	"golang.org/x/crypto/argon2"
)

// argonCost is the work and memory one Argon2id hash takes. It is written
// into each hash, so a hash is checked at the cost it was made with, and
// the cost of new hashes can change.
type argonCost struct {
	time    uint32
	memory  uint32 // in KiB
	threads uint8
}

// serverCost is 64 MB and 3 passes, as OWASP suggests for 2024 onward with
// memory to spare.
var serverCost = argonCost{time: 3, memory: 64 * 1024, threads: 2}

// testCost is what a test binary hashes with: under the race detector one
// hash at serverCost takes half a second, and the tests make hundreds.
var testCost = argonCost{time: 1, memory: 64, threads: 2}

// cost is what new hashes take: testCost only in a test binary, which is
// the one place testing.Testing reports true.
func cost() argonCost {
	if testing.Testing() {
		return testCost
	}
	return serverCost
}

const argonKeyLen = 32

// HashPassword returns an Argon2id hash in the standard encoded form.
func HashPassword(password string) (string, error) { return hashAt(password, cost()) }

// hashAt is HashPassword at a cost.
func hashAt(password string, c argonCost) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, c.time, c.memory, c.threads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s", c.memory, c.time, c.threads,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

// CheckNoPassword takes as long as checking a password against a hash
// HashPassword made, and matches nothing: a sign-in as someone who is not
// there takes as long as one with a wrong password.
func CheckNoPassword(password string) {
	c := cost()
	argon2.IDKey([]byte(password), make([]byte, 16), c.time, c.memory, c.threads, argonKeyLen)
}

// CheckPassword reports whether password matches an encoded hash.
func CheckPassword(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false
	}
	var m, t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return false
	}
	salt, err1 := base64.RawStdEncoding.DecodeString(parts[4])
	want, err2 := base64.RawStdEncoding.DecodeString(parts[5])
	if err1 != nil || err2 != nil || m > 1<<21 || t > 20 {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, t, m, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// CheckPasswordRules refuses passwords too weak to accept.
func CheckPasswordRules(password string) error {
	if len(password) < 10 {
		return errors.New("a password needs at least 10 characters")
	}
	if len(password) > 256 {
		return errors.New("a password is at most 256 characters")
	}
	return nil
}

// Random returns n random bytes as URL-safe text.
func Random(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // the system has no randomness: nothing safe can be done
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// Hash returns the hex SHA-256 of a token. Tokens are long and random, so a
// plain hash is enough to store them safely.
func Hash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// NewAPIToken returns a new API token and the prefix shown for it later.
// The token is "qd_" + 8 visible characters + "_" + the secret part.
func NewAPIToken() (token, prefix string) {
	prefix = "qd_" + Random(6)
	return prefix + "_" + Random(30), prefix
}

// Sealer encrypts secrets kept in the database (integration tokens, mail
// passwords) with the install's key.
type Sealer struct{ aead cipher.AEAD }

// NewSealer derives a sealer from the install secret.
func NewSealer(secret []byte) (*Sealer, error) {
	key := sha256.Sum256(append([]byte("quadit seal v1\n"), secret...))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	return &Sealer{aead: aead}, err
}

// Seal encrypts plain. The result is safe to store as text.
func (s *Sealer) Seal(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return "v1:" + base64.RawStdEncoding.EncodeToString(s.aead.Seal(nonce, nonce, []byte(plain), nil)), nil
}

// Open decrypts what Seal made.
func (s *Sealer) Open(sealed string) (string, error) {
	if sealed == "" {
		return "", nil
	}
	raw, err := base64.RawStdEncoding.DecodeString(strings.TrimPrefix(sealed, "v1:"))
	if err != nil || len(raw) < s.aead.NonceSize() {
		return "", errors.New("sealed value is damaged")
	}
	plain, err := s.aead.Open(nil, raw[:s.aead.NonceSize()], raw[s.aead.NonceSize():], nil)
	if err != nil {
		return "", errors.New("sealed value cannot be opened with this install's secret")
	}
	return string(plain), nil
}
