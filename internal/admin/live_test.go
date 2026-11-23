package admin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/withwillowai/otlp-router/internal/router"
	"github.com/withwillowai/otlp-router/internal/telemetry"
)

func getLive(t *testing.T, s *server, path string) (int, liveResponse) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.live(rec, httptest.NewRequest("GET", path, nil))
	var out liveResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestLiveMergesReplicasNewestFirst(t *testing.T) {
	s := peerServer(t)
	a := fakePeer(t, s.peerToken(), "/internal/live", liveResponse{Entries: []router.LiveEntry{
		{ID: "a-1", Time: 100, UpdatedAt: 100, Signal: "logs", Status: router.LiveAccepted},
		{ID: "a-2", Time: 300, UpdatedAt: 300, Signal: "logs", Status: router.LiveAccepted},
	}})
	b := fakePeer(t, s.peerToken(), "/internal/live", liveResponse{Entries: []router.LiveEntry{
		{ID: "b-1", Time: 200, UpdatedAt: 200, Signal: "traces", Status: router.LiveRejected, Error: "missing or invalid ingest token"},
	}})
	s.resolvePeers = func(context.Context) ([]string, error) { return []string{a, b, "127.0.0.1:1"}, nil }

	code, got := getLive(t, s, "/api/live?since=0")
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d", code)
	}
	if got.Pods == nil || got.Pods.Reporting != 2 || got.Pods.Total != 3 {
		t.Fatalf("pods: want 2 of 3, got %+v", got.Pods)
	}
	var ids []string
	for _, e := range got.Entries {
		ids = append(ids, e.ID)
	}
	if len(ids) != 3 || ids[0] != "a-2" || ids[1] != "b-1" || ids[2] != "a-1" {
		t.Fatalf("want a-2, b-1, a-1, got %v", ids)
	}
}

func TestInternalLiveNeedsPeerToken(t *testing.T) {
	s := peerServer(t)
	h := s.routes()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/internal/live", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("without token: want 404, got %d", rec.Code)
	}
	req := httptest.NewRequest("GET", "/internal/live", nil)
	req.Header.Set(peerHeader, s.peerToken())
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("with token: want 200, got %d", rec.Code)
	}
}

func TestLiveSingleReplicaAndDisabled(t *testing.T) {
	s := peerServer(t)
	s.Config.Peers = ""
	s.Router.Rejected(telemetry.Logs, "missing or invalid ingest token", map[string]string{"x-user-email": "dev@acme.com"})

	code, got := getLive(t, s, "/api/live")
	if code != http.StatusOK || got.Pods != nil || len(got.Entries) != 1 || got.Entries[0].User != "dev@acme.com" {
		t.Fatalf("want this replica's entry and no pods report, got %d %+v", code, got)
	}
	if _, again := getLive(t, s, "/api/live?since="+strconv.FormatInt(got.Entries[0].UpdatedAt, 10)); len(again.Entries) != 0 {
		t.Fatalf("since should skip entries already seen, got %+v", again.Entries)
	}

	s.Router.DisableLive()
	if code, _ := getLive(t, s, "/api/live"); code != http.StatusNotFound {
		t.Fatalf("disabled: want 404, got %d", code)
	}
}

func getLiveContent(t *testing.T, s *server, id string) (int, liveContentResponse) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.liveContent(rec, httptest.NewRequest("GET", "/api/live/content?id="+id, nil))
	var out liveContentResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestLiveContentOffByDefault(t *testing.T) {
	s := peerServer(t)
	if code, _ := getLiveContent(t, s, "a-1"); code != http.StatusNotFound {
		t.Fatalf("want 404 while content is off, got %d", code)
	}
	req := httptest.NewRequest("GET", "/internal/live/content?id=a-1", nil)
	req.Header.Set(peerHeader, s.peerToken())
	rec := httptest.NewRecorder()
	s.routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("peers get 404 too, got %d", rec.Code)
	}
}

func TestLiveContentAsksTheReplicaThatHasIt(t *testing.T) {
	s := peerServer(t)
	s.Router.EnableLiveContent()
	has := fakePeer(t, s.peerToken(), "/internal/live/content", liveContentResponse{
		Available:   true,
		LiveContent: router.LiveContent{Received: json.RawMessage(`{"resourceLogs":[]}`)},
	})
	hasNot := fakePeer(t, s.peerToken(), "/internal/live/content", liveContentResponse{})
	s.resolvePeers = func(context.Context) ([]string, error) { return []string{hasNot, has}, nil }

	code, got := getLiveContent(t, s, "other-7")
	if code != http.StatusOK || !got.Available || string(got.Received) != `{"resourceLogs":[]}` {
		t.Fatalf("want the other replica's telemetry, got %d %+v", code, got)
	}

	s.resolvePeers = func(context.Context) ([]string, error) { return []string{hasNot}, nil }
	if code, got = getLiveContent(t, s, "other-7"); code != http.StatusOK || got.Available {
		t.Fatalf("want unavailable when no replica has it, got %d %+v", code, got)
	}
}
