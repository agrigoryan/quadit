package auth

import (
	"testing"
	"time"
)

func TestTOTP(t *testing.T) {
	// The RFC 6238 test secret "12345678901234567890" at T=59 gives 287082.
	secret := b32.EncodeToString([]byte("12345678901234567890"))
	if got := TOTPCode(secret, time.Unix(59, 0)); got != "287082" {
		t.Fatalf("code = %s, want 287082", got)
	}
	if _, ok := CheckTOTP(secret, "287 082", time.Unix(59+30, 0)); !ok {
		t.Fatal("a code one step old should pass")
	}
	if _, ok := CheckTOTP(secret, "287082", time.Unix(59+120, 0)); ok {
		t.Fatal("an old code passed")
	}
}

func TestPasswordAndSeal(t *testing.T) {
	h, err := HashPassword("correct horse")
	if err != nil || !CheckPassword(h, "correct horse") || CheckPassword(h, "wrong") {
		t.Fatalf("password hash round trip failed: %v", err)
	}
	s, _ := NewSealer([]byte("an install secret of some length"))
	sealed, _ := s.Seal("ghp_token")
	if plain, err := s.Open(sealed); err != nil || plain != "ghp_token" || sealed == "ghp_token" {
		t.Fatalf("seal round trip: %q %v", plain, err)
	}
	other, _ := NewSealer([]byte("a different install secret here"))
	if _, err := other.Open(sealed); err == nil {
		t.Fatal("another install's key opened the secret")
	}
}
