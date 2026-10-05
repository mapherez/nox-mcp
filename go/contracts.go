package noxmcp

import (
	"embed"
	"encoding/json"
	"errors"
	"github.com/google/jsonschema-go/jsonschema"
	"sync"
)

//go:embed contracts/*.json
var Contracts embed.FS
var validators sync.Map

func ValidateFrame(schemaName string, data []byte) error {
	return ValidateFrameWithLimit(schemaName, data, MaxPayloadBytes)
}
func ValidateFrameWithLimit(schemaName string, data []byte, maxBytes int) error {
	if len(data) > maxBytes {
		return errors.New("bridge payload limit")
	}
	if cached, ok := validators.Load(schemaName); ok {
		var value any
		if json.Unmarshal(data, &value) != nil {
			return errors.New("invalid JSON")
		}
		return cached.(*jsonschema.Resolved).Validate(value)
	}
	schemaJSON, err := Contracts.ReadFile("contracts/" + schemaName + ".schema.json")
	if err != nil {
		return errors.New("unknown bridge schema")
	}
	var schema jsonschema.Schema
	if json.Unmarshal(schemaJSON, &schema) != nil {
		return errors.New("invalid bridge schema")
	}
	resolved, err := schema.Resolve(nil)
	if err != nil {
		return err
	}
	validators.Store(schemaName, resolved)
	var value any
	if json.Unmarshal(data, &value) != nil {
		return errors.New("invalid JSON")
	}
	return resolved.Validate(value)
}
