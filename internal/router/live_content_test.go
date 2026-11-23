package router_test

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/withwillowai/otlp-router/internal/config"
	"github.com/withwillowai/otlp-router/internal/filter"
	"github.com/withwillowai/otlp-router/internal/ingest"
	"github.com/withwillowai/otlp-router/internal/router"
	"github.com/withwillowai/otlp-router/internal/store"
)

func liveRouter(t *testing.T, content bool) (*router.Router, http.Handler) {
	t.Helper()
	sink := newSink(t, http.StatusOK)
	rt := router.New(&store.Memory{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if content {
		rt.EnableLiveContent()
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	t.Cleanup(rt.Close)
	err := rt.Init(ctx, []config.Target{
		{Name: "Raw", Enabled: true, Type: config.TypeOTLPHTTP, Endpoint: sink.srv.URL},
		{
			Name: "Safe", Enabled: true, Type: config.TypeOTLPHTTP, Endpoint: sink.srv.URL,
			Filters: []filter.Rule{
				{Type: filter.Redact, Builtins: true},
				{Type: filter.HashAttributes, Keys: []string{"user.email"}, Salt: "s"},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	rt.SetIngestAuth(nil, true)
	return rt, (&ingest.Server{Router: rt, Authorize: rt.CheckIngest}).HTTPHandler()
}

func sendLogs(t *testing.T, h http.Handler, rt *router.Router) router.LiveEntry {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/logs", bytes.NewReader(claudeLogsProto(t)))
	req.Header.Set("Content-Type", "application/x-protobuf")
	h.ServeHTTP(httptest.NewRecorder(), req)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if es := rt.Live(0); len(es) == 1 && len(es[0].Targets) == 2 {
			return es[0]
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("request never reached both targets: %+v", rt.Live(0))
	return router.LiveEntry{}
}

func TestLiveSaysWhatEachTargetsFiltersChanged(t *testing.T) {
	rt, h := liveRouter(t, false)
	e := sendLogs(t, h, rt)
	got := map[string]router.LiveTarget{}
	for _, tg := range e.Targets {
		got[tg.ID] = tg
	}
	if raw := got["raw"]; raw.Rules != 0 || raw.Redacted+raw.Masked+raw.Hashed+raw.Removed != 0 {
		t.Fatalf("raw has no filters, got %+v", raw)
	}
	// Both records carry user.email; the redact rule had no secrets to find.
	if safe := got["safe"]; safe.Rules != 2 || safe.Hashed != 2 || safe.Redacted != 0 {
		t.Fatalf("safe: want 2 rules and 2 hashed values, got %+v", safe)
	}
	// Later results (sent) must not lose what the filters did.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		e = rt.Live(0)[0]
		for _, tg := range e.Targets {
			got[tg.ID] = tg
		}
		if got["safe"].Status == "sent" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got["safe"].Status != "sent" || got["safe"].Hashed != 2 {
		t.Fatalf("after sending, want the counts kept, got %+v", got["safe"])
	}
}

func TestLiveContentIsOffUnlessEnabled(t *testing.T) {
	rt, h := liveRouter(t, false)
	e := sendLogs(t, h, rt)
	if rt.LiveContentEnabled() {
		t.Fatal("content must be off by default")
	}
	if _, ok := rt.LiveContent(e.ID); ok {
		t.Fatal("no telemetry should be kept when content is off")
	}
}

func TestLiveContentShowsReceivedAndSentPerTarget(t *testing.T) {
	rt, h := liveRouter(t, true)
	e := sendLogs(t, h, rt)
	c, ok := rt.LiveContent(e.ID)
	if !ok {
		t.Fatal("content should be kept")
	}
	if !strings.Contains(string(c.Received), "dev@acme.com") {
		t.Fatalf("received should show the original email: %s", c.Received)
	}
	if !strings.Contains(string(c.Targets["raw"]), "dev@acme.com") {
		t.Fatalf("raw target gets the original: %s", c.Targets["raw"])
	}
	safe := string(c.Targets["safe"])
	if safe == "" || strings.Contains(safe, "dev@acme.com") || !strings.Contains(safe, "sha256:") {
		t.Fatalf("safe target should get hashed emails: %s", safe)
	}
	if _, ok := rt.LiveContent("nope-1"); ok {
		t.Fatal("an id from another boot is not here")
	}
	if _, ok := rt.LiveContent("garbage"); ok {
		t.Fatal("a malformed id is not here")
	}
}
