package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchModelTokenForwardsExternalRefreshHints(t *testing.T) {
	t.Helper()

	var got coordinatorModelTokenRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer coordinator-bearer" {
			t.Fatalf("authorization = %q", auth)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(coordinatorModelTokenResponse{
			Token:          "access-only",
			Label:          "primary",
			EntryID:        "entry-current",
			LeaseID:        "lease-new",
			LeaseExpiresAt: "2026-07-16T12:30:00Z",
		})
	}))
	defer server.Close()

	result, err := fetchModelTokenFromCoordinator(
		context.Background(),
		server.URL,
		"coordinator-bearer",
		"openai",
		true,
		"entry-current",
		"entry-exhausted",
		"agent:sora",
	)
	if err != nil {
		t.Fatalf("fetch model token: %v", err)
	}
	if result.Token != "access-only" {
		t.Fatalf("token = %q", result.Token)
	}
	if got.Provider != "openai" {
		t.Fatalf("provider = %q", got.Provider)
	}
	if !got.ForceRefresh {
		t.Fatal("force_refresh was not forwarded")
	}
	if got.PreferredEntryID != "entry-current" {
		t.Fatalf("preferred_entry_id = %q", got.PreferredEntryID)
	}
	if got.ExcludeEntryID != "entry-exhausted" {
		t.Fatalf("exclude_entry_id = %q", got.ExcludeEntryID)
	}
	if got.StickyKey != "agent:sora" {
		t.Fatalf("sticky_key = %q", got.StickyKey)
	}
}
