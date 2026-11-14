package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// Two-step codes are standard TOTP (RFC 6238): six digits, 30 seconds,
// SHA-1, which is what every authenticator app speaks.

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// NewTOTPSecret returns a new secret in the text form apps accept.
func NewTOTPSecret() string {
	raw := make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	return b32.EncodeToString(raw)
}

// TOTPURL is what an authenticator app scans.
func TOTPURL(issuer, account, secret string) string {
	v := url.Values{"secret": {secret}, "issuer": {issuer}, "algorithm": {"SHA1"}, "digits": {"6"}, "period": {"30"}}
	return "otpauth://totp/" + url.PathEscape(issuer+":"+account) + "?" + v.Encode()
}

func totpAt(secret string, step int64) (string, bool) {
	key, err := b32.DecodeString(strings.ToUpper(strings.ReplaceAll(secret, " ", "")))
	if err != nil {
		return "", false
	}
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(step))
	mac := hmac.New(sha1.New, key)
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	n := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", n%1_000_000), true
}

// TOTPCode returns the code for a moment in time.
func TOTPCode(secret string, at time.Time) string {
	c, _ := totpAt(secret, at.Unix()/30)
	return c
}

// CheckTOTP checks a code, allowing one step of clock drift either way. It
// returns the step the code belongs to, so a caller can refuse a code used
// twice.
func CheckTOTP(secret, code string, at time.Time) (step int64, ok bool) {
	code = strings.ReplaceAll(strings.TrimSpace(code), " ", "")
	if len(code) != 6 {
		return 0, false
	}
	now := at.Unix() / 30
	for _, s := range []int64{now, now - 1, now + 1} {
		if want, valid := totpAt(secret, s); valid && hmac.Equal([]byte(want), []byte(code)) {
			return s, true
		}
	}
	return 0, false
}

// NewRecoveryCodes returns ten one-time codes for when the phone is gone.
func NewRecoveryCodes() []string {
	out := make([]string, 10)
	const alphabet = "abcdefghjkmnpqrstuvwxyz23456789" // no look-alikes
	for i := range out {
		raw := make([]byte, 10)
		rand.Read(raw)
		var b strings.Builder
		for j, c := range raw {
			if j == 5 {
				b.WriteByte('-')
			}
			b.WriteByte(alphabet[int(c)%len(alphabet)])
		}
		out[i] = b.String()
	}
	return out
}
