package noxmcp

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"strings"
	"time"
	"unicode/utf8"
)

type SuiteVerificationOptions struct {
	Issuer, Audience, ProductID, AssociationID, GatewayServiceID string
	RegistrationRevision, ServiceCredentialRevision              string
	// Immutable trusted local keys; refresh outside verification, never via JWT URLs.
	Keys map[string]SuiteSigningKey
	Now  time.Time
	Kind string // empty accepts either explicitly typed profile; otherwise user or probe
}

// Private fields prevent deserialized claims or metadata becoming a verified identity.
type VerifiedSuiteIdentity struct {
	token, kind           string
	claims, context       JSON
	admittedAt, expiresAt time.Time
	valid                 bool
}

func (v *VerifiedSuiteIdentity) Kind() string {
	if v == nil || !v.valid {
		return ""
	}
	return v.kind
}
func (v *VerifiedSuiteIdentity) Context() JSON {
	if v == nil || !v.valid {
		return nil
	}
	return jsonObject(v.context)
}
func (v *VerifiedSuiteIdentity) Claims() JSON {
	if v == nil || !v.valid {
		return nil
	}
	return jsonObject(v.claims)
}
func (v *VerifiedSuiteIdentity) ExpiresAt() time.Time {
	if v == nil || !v.valid {
		return time.Time{}
	}
	return v.expiresAt
}

// AccessToken is secret. Use only to forward to the verified bound product.
func (v *VerifiedSuiteIdentity) AccessToken() string {
	if v == nil || !v.valid {
		return ""
	}
	return v.token
}
func (v *VerifiedSuiteIdentity) String() string {
	return "VerifiedSuiteIdentity(" + v.Kind() + ", token redacted)"
}
func (v *VerifiedSuiteIdentity) GoString() string { return v.String() }
func (v *VerifiedSuiteIdentity) MarshalJSON() ([]byte, error) {
	return json.Marshal(JSON{"kind": v.Kind(), "expiresAt": v.ExpiresAt()})
}

func suiteBase64(value string, max int) ([]byte, error) {
	if len(value) == 0 || len(value) > (max*4+2)/3 {
		return nil, suiteFailure("INVALID_DELEGATION")
	}
	bytes, e := base64.RawURLEncoding.Strict().DecodeString(value)
	if e != nil || len(bytes) > max || base64.RawURLEncoding.EncodeToString(bytes) != value {
		return nil, suiteFailure("INVALID_DELEGATION")
	}
	return bytes, nil
}
func VerifySuiteToken(token string, options SuiteVerificationOptions) (*VerifiedSuiteIdentity, error) {
	invalid := func() (*VerifiedSuiteIdentity, error) { return nil, suiteFailure("INVALID_DELEGATION") }
	now := options.Now
	if now.IsZero() {
		now = time.Now()
	}
	resource, e := NormalizeSuiteResource(options.Audience)
	if e != nil || resource != options.Audience || options.Issuer == "" || options.ProductID == "" || options.AssociationID == "" || options.GatewayServiceID == "" || now.UnixMilli() < 0 || len(token) > SuiteMaxTokenBytes {
		return invalid()
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return invalid()
	}
	encodedHeader, e := suiteBase64(parts[0], SuiteMaxTokenBytes)
	if e != nil {
		return invalid()
	}
	value, e := ParseSuiteJSON(encodedHeader)
	if e != nil {
		return invalid()
	}
	header := object(value)
	if text(header["alg"]) != "ES256" || (text(header["typ"]) != "nox-delegation+jwt" && text(header["typ"]) != "nox-service+jwt") || text(header["kid"]) == "" || utf8.RuneCountInString(text(header["kid"])) > 256 {
		return invalid()
	}
	for _, name := range []string{"crit", "b64", "jku", "x5u", "jwk", "x5c"} {
		if _, found := header[name]; found {
			return invalid()
		}
	}
	kind := "user"
	if header["typ"] == "nox-service+jwt" {
		kind = "probe"
	}
	if options.Kind != "" && options.Kind != kind {
		return invalid()
	}
	key, found := options.Keys[text(header["kid"])]
	if !found {
		return invalid()
	}
	keyJSON, e := json.Marshal(key)
	if e != nil {
		return invalid()
	}
	if _, e = LoadSuiteSigningKey(keyJSON); e != nil {
		return invalid()
	}
	if key.Kid != nil && *key.Kid != text(header["kid"]) {
		return invalid()
	}
	x, e := suiteBase64(key.X, 32)
	if e != nil || len(x) != 32 {
		return invalid()
	}
	y, e := suiteBase64(key.Y, 32)
	if e != nil || len(y) != 32 {
		return invalid()
	}
	public := ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}
	if !public.Curve.IsOnCurve(public.X, public.Y) {
		return invalid()
	}
	signature, e := suiteBase64(parts[2], 64)
	if e != nil || len(signature) != 64 {
		return invalid()
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if !ecdsa.Verify(&public, digest[:], new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:])) {
		return invalid()
	}
	payload, e := suiteBase64(parts[1], SuiteMaxTokenBytes)
	if e != nil {
		return invalid()
	}
	schema := "delegation-claims"
	if kind == "probe" {
		schema = "probe-claims"
	}
	claims, e := LoadSuiteDocument(schema, payload)
	if e != nil {
		return invalid()
	}
	bound := object(claims["nox"])
	actor := text(claims["sub"])
	if kind == "user" {
		actor = text(object(claims["act"])["sub"])
	}
	if claims["iss"] != options.Issuer || claims["aud"] != options.Audience || bound["productId"] != options.ProductID || bound["associationId"] != options.AssociationID || actor != options.GatewayServiceID {
		return invalid()
	}
	if options.RegistrationRevision != "" && bound["registrationRevision"] != options.RegistrationRevision || options.ServiceCredentialRevision != "" && bound["serviceCredentialRevision"] != options.ServiceCredentialRevision {
		return invalid()
	}
	expiresMS := claims["exp"].(float64)*1000 - SuiteClockSafetyMS
	if expiresMS > 9007199254740991 || float64(now.UnixMilli()) >= expiresMS || claims["iat"].(float64)*1000 > float64(now.UnixMilli()+SuiteClockSafetyMS) || claims["nbf"].(float64)*1000 > float64(now.UnixMilli()+SuiteClockSafetyMS) {
		return invalid()
	}
	context := JSON{"contractVersion": "1.0", "productId": bound["productId"], "registrationRevision": bound["registrationRevision"], "associationId": bound["associationId"], "serviceCredentialRevision": bound["serviceCredentialRevision"]}
	if kind == "user" {
		context["userId"] = claims["sub"]
		context["keyId"] = bound["keyId"]
		context["authRevision"] = bound["authRevision"]
		context["gatewayServiceId"] = actor
		context["scopes"] = strings.Split(text(claims["scope"]), " ")
	} else {
		context["serviceId"] = actor
		context["purpose"] = "mcp-probe"
	}
	return &VerifiedSuiteIdentity{token: token, kind: kind, claims: claims, context: context, admittedAt: now, expiresAt: time.UnixMilli(int64(expiresMS)), valid: true}, nil
}
func VerifySuiteAuthorizationResponse(data []byte, options SuiteVerificationOptions) (*VerifiedSuiteIdentity, error) {
	schema := "authorization-response"
	if options.Kind == "probe" {
		schema = "probe-response"
	} else {
		options.Kind = "user"
	}
	response, e := LoadSuiteDocument(schema, data)
	if e != nil {
		return nil, suiteFailure("INVALID_DELEGATION")
	}
	identity, e := VerifySuiteToken(text(response["accessToken"]), options)
	if e != nil {
		return nil, e
	}
	supplied := object(response["context"])
	for key, expected := range identity.context {
		if key == "scopes" {
			got := map[string]bool{}
			for _, scope := range array(supplied[key]) {
				got[text(scope)] = true
			}
			required := expected.([]string)
			if len(got) != len(required) {
				return nil, suiteFailure("INVALID_DELEGATION")
			}
			for _, scope := range required {
				if !got[scope] {
					return nil, suiteFailure("INVALID_DELEGATION")
				}
			}
		} else if supplied[key] != expected {
			return nil, suiteFailure("INVALID_DELEGATION")
		}
	}
	expires, e := ParseSuiteTimestamp(text(response["expiresAt"]))
	if e != nil || float64(expires.UnixMilli()) != identity.claims["exp"].(float64)*1000 {
		return nil, suiteFailure("INVALID_DELEGATION")
	}
	return identity, nil
}
func RequireSuiteMethod(identity *VerifiedSuiteIdentity, method string, now time.Time) error {
	if identity == nil || !identity.valid || now.Before(identity.admittedAt.Add(-SuiteClockSafetyMS*time.Millisecond)) || !now.Before(identity.expiresAt) {
		return suiteFailure("INVALID_DELEGATION")
	}
	if identity.kind == "probe" && method != "initialize" && method != "notifications/initialized" && method != "ping" && method != "server/discover" {
		return suiteFailure("FORBIDDEN")
	}
	return nil
}
func CreateSuitePairingProof(secret []byte, binding SuitePairingBinding) (string, error) {
	if len(secret) < 32 || len(secret) > 96 {
		return "", suiteFailure("PAIRING_CONFLICT")
	}
	data, e := json.Marshal(binding)
	if e != nil {
		return "", e
	}
	document, e := LoadSuiteDocument("pairing-binding", data)
	if e != nil {
		return "", e
	}
	canonical, e := Canonicalize(document)
	if e != nil {
		return "", e
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(canonical))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}
func VerifySuitePairingProof(secret []byte, binding SuitePairingBinding, proof string) bool {
	expected, e := CreateSuitePairingProof(secret, binding)
	if e != nil {
		return false
	}
	actual, e := suiteBase64(proof, 32)
	if e != nil || len(actual) != 32 {
		return false
	}
	wanted, _ := suiteBase64(expected, 32)
	return hmac.Equal(actual, wanted)
}
func SuiteCredentialPartition(apiKey string, processSecret []byte) (string, error) {
	if apiKey == "" || !utf8.ValidString(apiKey) || len(apiKey) > 4096 || len(processSecret) < 32 {
		return "", suiteFailure("INVALID_INTEGRATION")
	}
	mac := hmac.New(sha256.New, processSecret)
	mac.Write([]byte("nox:credential-partition:1.0\x00"))
	mac.Write([]byte(apiKey))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}
