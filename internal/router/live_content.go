package router

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"github.com/withwillowai/otlp-router/internal/telemetry"
)

const (
	// liveContentEntries is how many of the newest requests keep their
	// telemetry. Older ones lose it while their details stay.
	liveContentEntries = 50
	// liveContentMaxItems skips requests too big to keep, so the memory used is
	// bounded.
	liveContentMaxItems = 500
)

// LiveContent is the telemetry of one live request, as OTLP JSON: what the
// router received and what each target was given after its filters. It is
// kept in memory only and shown only to the logged-in admin.
type LiveContent struct {
	// Received is the request before any target's filters.
	Received json.RawMessage `json:"received,omitempty"`
	// Targets maps a target id to the payload it was sent. A target whose
	// filters removed everything has no entry.
	Targets map[string]json.RawMessage `json:"targets,omitempty"`
	// Skipped says why nothing was kept, e.g. the request was too large.
	Skipped string `json:"skipped,omitempty"`
}

type liveContentLog struct {
	mu    sync.Mutex
	boot  string
	order []uint64
	by    map[uint64]*LiveContent
}

func newLiveContentLog(boot string) *liveContentLog {
	return &liveContentLog{boot: boot, by: map[uint64]*LiveContent{}}
}

func (c *liveContentLog) received(seq uint64, p telemetry.Payload) {
	rec := &LiveContent{}
	switch raw, err := encodeForLive(p); {
	case err != nil:
		rec.Skipped = err.Error()
	default:
		rec.Received = raw
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.by[seq] = rec
	c.order = append(c.order, seq)
	for len(c.order) > liveContentEntries {
		delete(c.by, c.order[0])
		c.order = c.order[1:]
	}
}

func (c *liveContentLog) sent(seq uint64, target string, p telemetry.Payload) {
	raw, err := encodeForLive(p)
	c.mu.Lock()
	defer c.mu.Unlock()
	rec := c.by[seq]
	if rec == nil || err != nil {
		return
	}
	if rec.Targets == nil {
		rec.Targets = map[string]json.RawMessage{}
	}
	rec.Targets[target] = raw
}

func (c *liveContentLog) get(seq uint64) (LiveContent, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	rec := c.by[seq]
	if rec == nil {
		return LiveContent{}, false
	}
	out := *rec
	out.Targets = make(map[string]json.RawMessage, len(rec.Targets))
	for k, v := range rec.Targets {
		out.Targets[k] = v
	}
	return out, true
}

func encodeForLive(p telemetry.Payload) (json.RawMessage, error) {
	if n := p.Items(); n > liveContentMaxItems {
		return nil, fmt.Errorf("not kept: %d items is more than the %d the live view keeps", n, liveContentMaxItems)
	}
	return p.Encode(telemetry.JSON)
}

// EnableLiveContent makes the live view keep the telemetry of the latest
// requests in memory. It does nothing when the live view is off. Call it
// before serving.
func (r *Router) EnableLiveContent() {
	if r.live != nil {
		r.liveContent = newLiveContentLog(r.live.boot)
	}
}

func (r *Router) LiveContentEnabled() bool { return r.liveContent != nil }

// LiveContent returns the telemetry of a live request this replica handled.
// The id is the one of its LiveEntry; another replica's requests are not here.
func (r *Router) LiveContent(id string) (LiveContent, bool) {
	if r.liveContent == nil {
		return LiveContent{}, false
	}
	boot, n, ok := strings.Cut(id, "-")
	if !ok || boot != r.liveContent.boot {
		return LiveContent{}, false
	}
	seq, err := strconv.ParseUint(n, 10, 64)
	if err != nil {
		return LiveContent{}, false
	}
	return r.liveContent.get(seq)
}
