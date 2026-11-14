package server

import (
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
	"io"
	"math/big"
	"strings"
	"testing"

	"golang.org/x/crypto/hkdf"
)

// TestPushEncryption plays the browser: it makes a subscription's keys,
// lets the server encrypt a message for them, and decrypts it the way a
// browser does (RFC 8291). It also checks the server's signed token.
func TestPushEncryption(t *testing.T) {
	ua, _ := ecdh.P256().GenerateKey(rand.Reader)
	auth := make([]byte, 16)
	rand.Read(auth)
	msg := []byte(`{"title":"Aram asked you a question","body":"Which explosion?","url":"/games/task/SVA-1"}`)
	body, err := encryptPush(base64.RawURLEncoding.EncodeToString(ua.PublicKey().Bytes()), base64.RawURLEncoding.EncodeToString(auth), msg)
	if err != nil {
		t.Fatal(err)
	}
	// Header: salt(16) | record size(4) | key length(1) | server key | ciphertext.
	salt, rs, klen := body[:16], binary.BigEndian.Uint32(body[16:20]), int(body[20])
	asPub, ciphertext := body[21:21+klen], body[21+klen:]
	if rs != 4096 || klen != 65 {
		t.Fatalf("header: record size %d, key length %d", rs, klen)
	}
	as, err := ecdh.P256().NewPublicKey(asPub)
	if err != nil {
		t.Fatal(err)
	}
	shared, _ := ua.ECDH(as)
	expand := func(secret, salt, info []byte, n int) []byte {
		out := make([]byte, n)
		io.ReadFull(hkdf.New(sha256.New, secret, salt, info), out)
		return out
	}
	info := append(append([]byte("WebPush: info\x00"), ua.PublicKey().Bytes()...), asPub...)
	ikm := expand(shared, auth, info, 32)
	cek := expand(ikm, salt, []byte("Content-Encoding: aes128gcm\x00"), 16)
	nonce := expand(ikm, salt, []byte("Content-Encoding: nonce\x00"), 12)
	block, _ := aes.NewCipher(cek)
	gcm, _ := cipher.NewGCM(block)
	plain, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		t.Fatalf("the browser could not decrypt the message: %v", err)
	}
	if plain[len(plain)-1] != 0x02 || string(plain[:len(plain)-1]) != string(msg) {
		t.Fatalf("decrypted to %q", plain)
	}

	// The token is a JWT signed with the server's key, for the push service.
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	token, err := vapidToken(key, "https://push.example.com", "https://quadit.example.com")
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("token = %q", token)
	}
	sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if len(sig) != 64 || !ecdsa.Verify(&key.PublicKey, sum[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		t.Fatal("the token's signature does not verify")
	}
	var claims struct{ Aud, Sub string }
	raw, _ := base64.RawURLEncoding.DecodeString(parts[1])
	json.Unmarshal(raw, &claims)
	if claims.Aud != "https://push.example.com" || claims.Sub != "https://quadit.example.com" {
		t.Fatalf("claims = %+v", claims)
	}
}
