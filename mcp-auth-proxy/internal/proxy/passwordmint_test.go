package proxy

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// makeJWT builds an unsigned-but-well-formed JWT carrying the given exp.
func makeJWT(t *testing.T, exp int64) string {
	t.Helper()
	hdr := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload, _ := json.Marshal(map[string]int64{"exp": exp})
	body := base64.RawURLEncoding.EncodeToString(payload)
	return hdr + "." + body + ".sig"
}

func TestPasswordMintLoginSuccess(t *testing.T) {
	exp := time.Now().Add(15 * time.Minute).Unix()
	access := makeJWT(t, exp)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/id/api/auth/login/" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["username"] != "agent-ryo" || body["password"] != "s3cr3t" {
			t.Errorf("unexpected credentials in request: %+v", body)
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"access": access, "refresh": "refresh-tok"})
	}))
	defer srv.Close()

	c := NewPasswordMintClient(srv.URL+"/id/api/auth/login/", srv.URL+"/id/api/auth/refresh/", "agent-ryo", "s3cr3t")
	sess, err := c.Login(context.Background())
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if sess.Access != access || sess.Refresh != "refresh-tok" {
		t.Fatalf("unexpected session tokens")
	}
	if sess.Exp.Unix() != exp {
		t.Fatalf("exp not parsed: got %v want unix %d", sess.Exp, exp)
	}
}

func TestPasswordMintRejectionRedactsPassword(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Reflect the password in the error body to prove the client does NOT
		// surface the response body verbatim.
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"invalid credentials for password hunter2"}`))
	}))
	defer srv.Close()

	c := NewPasswordMintClient(srv.URL+"/login/", srv.URL+"/refresh/", "agent-ryo", "hunter2")
	_, err := c.Login(context.Background())
	if err == nil {
		t.Fatal("expected error on 401")
	}
	if strings.Contains(err.Error(), "hunter2") {
		t.Fatalf("error leaked password/response body: %v", err)
	}
	if !strings.Contains(err.Error(), "401") {
		t.Fatalf("error should surface status: %v", err)
	}
}

func TestPasswordMintRefresh(t *testing.T) {
	access := makeJWT(t, time.Now().Add(15*time.Minute).Unix())
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["refresh"] != "old-refresh" {
			t.Errorf("unexpected refresh token: %+v", body)
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"access": access, "refresh": "new-refresh"})
	}))
	defer srv.Close()

	c := NewPasswordMintClient(srv.URL+"/login/", srv.URL+"/refresh/", "agent-ryo", "s3cr3t")
	sess, err := c.Refresh(context.Background(), "old-refresh")
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if sess.Refresh != "new-refresh" {
		t.Fatalf("refresh token not rotated: %q", sess.Refresh)
	}
}

func TestPasswordMintMissingAccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"refresh":"only-refresh"}`))
	}))
	defer srv.Close()
	c := NewPasswordMintClient(srv.URL+"/login/", srv.URL+"/refresh/", "u", "p")
	if _, err := c.Login(context.Background()); err == nil {
		t.Fatal("expected error when access token missing")
	}
}

func TestJWTExp(t *testing.T) {
	exp := time.Now().Add(time.Hour).Unix()
	got, err := jwtExp(makeJWT(t, exp))
	if err != nil {
		t.Fatalf("jwtExp: %v", err)
	}
	if got.Unix() != exp {
		t.Fatalf("got %d want %d", got.Unix(), exp)
	}
	if _, err := jwtExp("not-a-jwt"); err == nil {
		t.Fatal("expected error for non-JWT")
	}
	noExp := base64.RawURLEncoding.EncodeToString([]byte(`{}`))
	if _, err := jwtExp("h." + noExp + ".s"); err == nil {
		t.Fatal("expected error for JWT without exp")
	}
}

func TestRefreshEmptyToken(t *testing.T) {
	c := NewPasswordMintClient("http://x/login/", "http://x/refresh/", "u", "p")
	if _, err := c.Refresh(context.Background(), ""); err == nil {
		t.Fatal("expected error on empty refresh token")
	}
}
