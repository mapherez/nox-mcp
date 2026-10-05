package noxmcp

import (
	"context"
	"errors"
	"github.com/golang-jwt/jwt/v5"
	"github.com/modelcontextprotocol/go-sdk/auth"
	"net/http"
	"strings"
)

// JWTVerifier accepts keys from a trusted issuer/JWKS adapter. It never reads key URLs
// from token headers. Audience, issuer and expiry are mandatory.
func JWTVerifier(issuer, audience string, key jwt.Keyfunc) (auth.TokenVerifier, error) {
	if issuer == "" || audience == "" || key == nil {
		return nil, errors.New("issuer, audience and trusted key function required")
	}
	return func(ctx context.Context, raw string, request *http.Request) (*auth.TokenInfo, error) {
		token, err := jwt.Parse(raw, key, jwt.WithIssuer(issuer), jwt.WithAudience(audience), jwt.WithExpirationRequired(), jwt.WithValidMethods([]string{"RS256", "ES256", "EdDSA"}), jwt.WithIssuedAt())
		if err != nil || !token.Valid {
			return nil, auth.ErrInvalidToken
		}
		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			return nil, auth.ErrInvalidToken
		}
		expiry, err := claims.GetExpirationTime()
		if err != nil || expiry == nil {
			return nil, auth.ErrInvalidToken
		}
		subject, err := claims.GetSubject()
		if err != nil || subject == "" {
			return nil, auth.ErrInvalidToken
		}
		scope, _ := claims["scope"].(string)
		return &auth.TokenInfo{Scopes: strings.Fields(scope), Expiration: expiry.Time, UserID: subject, Extra: map[string]any(claims)}, nil
	}, nil
}
