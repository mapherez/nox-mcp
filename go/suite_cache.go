package noxmcp

import (
	"container/list"
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sync"
	"time"
)

type SuiteAuthorizationPartition struct {
	CredentialPartition, Issuer, Audience, GatewayServiceID, ServiceCredentialRevision, ProductID, AssociationID, RegistrationRevision, Kind string
}

func SuiteAuthorizationPartitionKey(p SuiteAuthorizationPartition) (string, error) {
	kind := p.Kind
	if kind == "" {
		kind = "user"
	}
	parts := []string{p.CredentialPartition, p.Issuer, p.Audience, p.GatewayServiceID, p.ServiceCredentialRevision, p.ProductID, p.AssociationID, p.RegistrationRevision, kind}
	for _, v := range parts {
		if v == "" {
			return "", suiteFailure("INVALID_INTEGRATION")
		}
	}
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(p.CredentialPartition) || !ValidSuiteProductID(p.ProductID) || (kind != "user" && kind != "probe") {
		return "", suiteFailure("INVALID_INTEGRATION")
	}
	resource, e := NormalizeSuiteResource(p.Audience)
	if e != nil || resource != p.Audience {
		return "", suiteFailure("INVALID_INTEGRATION")
	}
	return Fingerprint(parts)
}
func ValidateSuiteAuthorizationPartition(p SuiteAuthorizationPartition, id *VerifiedSuiteIdentity, now time.Time) error {
	if _, e := SuiteAuthorizationPartitionKey(p); e != nil {
		return e
	}
	kind := p.Kind
	if kind == "" {
		kind = "user"
	}
	if id == nil || !id.valid || id.kind != kind || id.claims["iss"] != p.Issuer || id.claims["aud"] != p.Audience || !now.Before(id.expiresAt) || now.Before(id.admittedAt.Add(-SuiteClockSafetyMS*time.Millisecond)) {
		return suiteFailure("INVALID_DELEGATION")
	}
	c := id.context
	actor := text(c["gatewayServiceId"])
	if kind == "probe" {
		actor = text(c["serviceId"])
	}
	if c["productId"] != p.ProductID || c["associationId"] != p.AssociationID || c["registrationRevision"] != p.RegistrationRevision || c["serviceCredentialRevision"] != p.ServiceCredentialRevision || actor != p.GatewayServiceID {
		return suiteFailure("INVALID_DELEGATION")
	}
	return nil
}

type SuiteInvalidation struct {
	All                                                                    bool
	UserID, KeyID, ServiceID, CredentialRevision, ProductID, AssociationID string
}

func (s SuiteInvalidation) valid() bool {
	return s.All || s.UserID != "" || s.KeyID != "" || s.ServiceID != "" || s.CredentialRevision != "" || s.ProductID != "" || s.AssociationID != ""
}
func (s SuiteInvalidation) matches(id *VerifiedSuiteIdentity) bool {
	if s.All {
		return true
	}
	c := id.context
	actor := text(c["gatewayServiceId"])
	if id.kind == "probe" {
		actor = text(c["serviceId"])
	}
	for _, pair := range [][2]string{{s.UserID, text(c["userId"])}, {s.KeyID, text(c["keyId"])}, {s.ServiceID, actor}, {s.CredentialRevision, text(c["serviceCredentialRevision"])}, {s.ProductID, text(c["productId"])}, {s.AssociationID, text(c["associationId"])}} {
		if pair[0] != "" && pair[0] != pair[1] {
			return false
		}
	}
	return true
}

type SuiteCacheOptions struct {
	MaxEntries, MaxBytes int
	Now                  func() time.Time
}
type suiteAuthorizationEntry struct {
	key      string
	identity *VerifiedSuiteIdentity
	deadline time.Time
	bytes    int
}
type suiteAuthorizationPending struct {
	generation uint64
	done       chan struct{}
	identity   *VerifiedSuiteIdentity
	err        error
}
type SuiteAuthorizationCache struct {
	mu                                        sync.Mutex
	entries                                   map[string]*list.Element
	order                                     *list.List
	pending                                   map[string]*suiteAuthorizationPending
	pendingCount, bytes, maxEntries, maxBytes int
	generation                                uint64
	now                                       func() time.Time
	lastWall                                  int64
}

func NewSuiteAuthorizationCache(options SuiteCacheOptions) (*SuiteAuthorizationCache, error) {
	if options.MaxEntries < 0 || options.MaxBytes < 0 {
		return nil, suiteFailure("INVALID_INTEGRATION")
	}
	if options.MaxEntries == 0 {
		options.MaxEntries = SuiteMaxAuthorizationEntries
	}
	if options.MaxBytes == 0 {
		options.MaxBytes = SuiteMaxAuthorizationBytes
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &SuiteAuthorizationCache{entries: map[string]*list.Element{}, order: list.New(), pending: map[string]*suiteAuthorizationPending{}, maxEntries: options.MaxEntries, maxBytes: options.MaxBytes, now: options.Now, lastWall: -1}, nil
}
func (c *SuiteAuthorizationCache) clockLocked() (time.Time, error) {
	if c.now == nil {
		c.now = time.Now
	}
	if c.entries == nil {
		c.entries = map[string]*list.Element{}
		c.order = list.New()
		c.pending = map[string]*suiteAuthorizationPending{}
		c.maxEntries = SuiteMaxAuthorizationEntries
		c.maxBytes = SuiteMaxAuthorizationBytes
		c.lastWall = -1
	}
	now := c.now()
	if now.UnixMilli() < 0 {
		return now, suiteFailure("INVALID_INTEGRATION")
	}
	if c.lastWall >= 0 && now.UnixMilli() < c.lastWall-SuiteClockSafetyMS {
		c.invalidateLocked(SuiteInvalidation{All: true})
		c.lastWall = now.UnixMilli()
		return now, suiteFailure("AUTHORIZATION_INVALIDATED")
	}
	if now.UnixMilli() > c.lastWall {
		c.lastWall = now.UnixMilli()
	}
	return now, nil
}
func (c *SuiteAuthorizationCache) removeLocked(element *list.Element) {
	entry := element.Value.(*suiteAuthorizationEntry)
	delete(c.entries, entry.key)
	c.bytes -= entry.bytes
	c.order.Remove(element)
}
func (c *SuiteAuthorizationCache) getLocked(key string, p SuiteAuthorizationPartition, now time.Time) (*VerifiedSuiteIdentity, error) {
	element := c.entries[key]
	if element == nil {
		return nil, nil
	}
	entry := element.Value.(*suiteAuthorizationEntry)
	if !now.Before(entry.deadline) || !now.Before(entry.identity.expiresAt) {
		c.removeLocked(element)
		return nil, nil
	}
	if e := ValidateSuiteAuthorizationPartition(p, entry.identity, now); e != nil {
		return nil, e
	}
	c.order.MoveToBack(element)
	return entry.identity, nil
}
func (c *SuiteAuthorizationCache) Get(p SuiteAuthorizationPartition) (*VerifiedSuiteIdentity, error) {
	key, e := SuiteAuthorizationPartitionKey(p)
	if e != nil {
		return nil, e
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now, e := c.clockLocked()
	if e != nil {
		return nil, e
	}
	return c.getLocked(key, p, now)
}
func (c *SuiteAuthorizationCache) Refresh(ctx context.Context, p SuiteAuthorizationPartition, load func(context.Context) (*VerifiedSuiteIdentity, error)) (*VerifiedSuiteIdentity, error) {
	key, e := SuiteAuthorizationPartitionKey(p)
	if e != nil {
		return nil, e
	}
	if load == nil {
		return nil, suiteFailure("INVALID_INTEGRATION")
	}
	if e = ctx.Err(); e != nil {
		return nil, e
	}
	c.mu.Lock()
	now, e := c.clockLocked()
	if e != nil {
		c.mu.Unlock()
		return nil, e
	}
	cached, e := c.getLocked(key, p, now)
	if cached != nil || e != nil {
		c.mu.Unlock()
		return cached, e
	}
	if pending := c.pending[key]; pending != nil && pending.generation == c.generation {
		c.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-pending.done:
			return pending.identity, pending.err
		}
	}
	if c.pendingCount >= c.maxEntries {
		c.mu.Unlock()
		return nil, suiteFailure("CACHE_LIMIT")
	}
	pending := &suiteAuthorizationPending{generation: c.generation, done: make(chan struct{})}
	c.pending[key] = pending
	c.pendingCount++
	c.mu.Unlock()
	var identity *VerifiedSuiteIdentity
	func() {
		defer func() {
			if recover() != nil {
				identity = nil
				e = suiteFailure("AUTHORIZATION_FAILED")
			}
		}()
		identity, e = load(ctx)
	}()
	c.mu.Lock()
	defer c.mu.Unlock()
	if pending.generation != c.generation {
		e = suiteFailure("AUTHORIZATION_INVALIDATED")
	}
	if e == nil {
		now, e = c.clockLocked()
	}
	if e == nil {
		e = ctx.Err()
	}
	if e == nil {
		e = ValidateSuiteAuthorizationPartition(p, identity, now)
	}
	if e == nil {
		claims, _ := json.Marshal(identity.claims)
		context, _ := json.Marshal(identity.context)
		size := len(identity.token) + len(claims) + len(context)
		if size > c.maxBytes {
			e = suiteFailure("CACHE_LIMIT")
		} else {
			for len(c.entries) >= c.maxEntries || c.bytes+size > c.maxBytes {
				c.removeLocked(c.order.Front())
			}
			remaining := identity.expiresAt.Sub(now)
			if remaining > SuiteAuthorizationLifetimeMS*time.Millisecond {
				remaining = SuiteAuthorizationLifetimeMS * time.Millisecond
			}
			element := c.order.PushBack(&suiteAuthorizationEntry{key: key, identity: identity, deadline: now.Add(remaining), bytes: size})
			c.entries[key] = element
			c.bytes += size
		}
	}
	if e != nil {
		identity = nil
	}
	pending.identity, pending.err = identity, e
	if c.pending[key] == pending {
		delete(c.pending, key)
	}
	c.pendingCount--
	close(pending.done)
	return identity, e
}
func (c *SuiteAuthorizationCache) invalidateLocked(selector SuiteInvalidation) {
	c.generation++
	for _, element := range c.entries {
		if selector.matches(element.Value.(*suiteAuthorizationEntry).identity) {
			c.removeLocked(element)
		}
	}
}
func (c *SuiteAuthorizationCache) Invalidate(selector SuiteInvalidation) error {
	if !selector.valid() {
		return suiteFailure("INVALID_INTEGRATION")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.invalidateLocked(selector)
	return nil
}
func (c *SuiteAuthorizationCache) ApplyEvent(data []byte) error {
	event, e := LoadSuiteDocument("event", data)
	if e != nil {
		return e
	}
	d := object(event["data"])
	switch event["type"] {
	case "authorization.invalidated":
		return c.Invalidate(SuiteInvalidation{All: d["all"] == true, UserID: text(d["userId"]), KeyID: text(d["keyId"]), ServiceID: text(d["serviceId"]), ProductID: text(d["productId"]), AssociationID: text(d["associationId"])})
	case "service.invalidated":
		return c.Invalidate(SuiteInvalidation{ServiceID: text(d["serviceId"]), CredentialRevision: text(d["credentialRevision"])})
	case "signing-keys.changed":
		return c.Invalidate(SuiteInvalidation{All: true})
	case "product.upserted":
		return c.Invalidate(SuiteInvalidation{ProductID: text(object(d["record"])["productId"])})
	case "product.removed":
		return c.Invalidate(SuiteInvalidation{ProductID: text(d["productId"]), AssociationID: text(d["associationId"])})
	}
	return nil
}

type SuiteCacheStats struct{ Entries, Bytes, Pending int }

func (c *SuiteAuthorizationCache) Stats() SuiteCacheStats {
	c.mu.Lock()
	defer c.mu.Unlock()
	return SuiteCacheStats{len(c.entries), c.bytes, c.pendingCount}
}
func (c *SuiteAuthorizationCache) String() string {
	s := c.Stats()
	return fmt.Sprintf("SuiteAuthorizationCache(entries=%d, bytes=%d, pending=%d)", s.Entries, s.Bytes, s.Pending)
}
func (c *SuiteAuthorizationCache) GoString() string { return c.String() }
