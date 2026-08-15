package proxy

import (
	"encoding/json"
	"io"
	"log"
	"sync"
	"time"
)

type AuditEmitter struct {
	mu sync.Mutex
	w  io.Writer
}

func NewAuditEmitter(w io.Writer) *AuditEmitter { return &AuditEmitter{w: w} }

func (a *AuditEmitter) Emit(eventType string, fields map[string]any) {
	if fields == nil {
		fields = map[string]any{}
	}
	fields["ts"] = time.Now().UTC().Format(time.RFC3339Nano)
	fields["event"] = eventType
	line, err := json.Marshal(fields)
	if err != nil {
		log.Printf("audit_marshal_failed event=%s err=%v", eventType, err)
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	_, _ = a.w.Write(append(line, '\n'))
}
