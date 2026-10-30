package noxmcp

import (
	"encoding/json"
	"regexp"
	"sort"
)

func SuiteAuthorizationViewKey(identity *VerifiedSuiteIdentity, credentialPartition, policyRevision string) (string, error) {
	if identity == nil || !identity.valid || !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(credentialPartition) || policyRevision == "" {
		return "", suiteFailure("INVALID_INTEGRATION")
	}
	c := identity.context
	subject := c["userId"]
	if identity.kind == "probe" {
		subject = c["serviceId"]
	}
	revision := c["authRevision"]
	if identity.kind == "probe" {
		revision = c["serviceCredentialRevision"]
	}
	scopes := []string{}
	if values, ok := c["scopes"].([]string); ok {
		scopes = append(scopes, values...)
	}
	sort.Strings(scopes)
	return Fingerprint([]any{credentialPartition, identity.claims["iss"], subject, c["keyId"], revision, scopes, policyRevision})
}

type SuiteGatewayOptions struct {
	ServerID, AuthorizationViewID, RegistryRevision, PolicyRevision string
	Sources                                                         []SuiteGatewaySource
	NowMS, AuthorizationExpiresAtMS                                 int64
	MaxBytes                                                        int
}

func rewriteSuiteCLI(input JSON, names map[string]string) (JSON, error) {
	if _, e := InterpretCLI(input); e != nil {
		return nil, e
	}
	result := jsonObject(input)
	rewrite := func(value JSON) error {
		alias, found := names[text(value["tool"])]
		if !found {
			return suiteFailure("INVALID_CLI")
		}
		value["tool"] = alias
		return nil
	}
	for _, parameter := range object(result["parameters"]) {
		if options := object(object(parameter)["options"]); options != nil {
			if e := rewrite(options); e != nil {
				return nil, e
			}
		}
	}
	if preview := object(result["preview"]); preview != nil {
		if e := rewrite(preview); e != nil {
			return nil, e
		}
	}
	for _, step := range array(result["workflow"]) {
		if object(step)["type"] == "call" {
			if e := rewrite(object(step)); e != nil {
				return nil, e
			}
		}
	}
	return result, nil
}
func ComposeSuiteGateway(options SuiteGatewayOptions) (SuiteGatewaySnapshot, error) {
	var result SuiteGatewaySnapshot
	maxBytes := options.MaxBytes
	if maxBytes == 0 {
		maxBytes = SuiteMaxGatewaySnapshotBytes
	}
	if maxBytes < 1 || options.ServerID == "" || options.RegistryRevision == "" || !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(options.AuthorizationViewID) {
		return result, suiteFailure("INVALID_GATEWAY")
	}
	if options.AuthorizationExpiresAtMS <= options.NowMS {
		return result, suiteFailure("INVALID_DELEGATION")
	}
	sources := []JSON{}
	seenProducts := map[string]bool{}
	for _, source := range options.Sources {
		data, e := json.Marshal(source)
		if e != nil {
			return result, suiteFailure("INVALID_GATEWAY")
		}
		value, e := LoadSuiteDocument("gateway-source", data)
		if e != nil {
			return result, e
		}
		id := text(object(value["registration"])["productId"])
		if seenProducts[id] {
			return result, suiteFailure("INVALID_GATEWAY")
		}
		seenProducts[id] = true
		sources = append(sources, value)
	}
	sort.Slice(sources, func(i, j int) bool {
		return text(object(sources[i]["registration"])["productId"]) < text(object(sources[j]["registration"])["productId"])
	})
	definitions, routes, diagnostics, components, products, views := []any{}, []any{}, []any{}, []any{}, []any{}, []any{}
	aliases := map[string]bool{}
	totalBytes := 0
	ttl := int64(30000)
	if remaining := options.AuthorizationExpiresAtMS - options.NowMS; remaining < ttl {
		ttl = remaining
	}
	for _, source := range sources {
		canonical, e := Canonicalize(source)
		if e != nil {
			return result, e
		}
		totalBytes += len(canonical)
		if totalBytes > maxBytes {
			return result, suiteFailure("PAYLOAD_LIMIT")
		}
		product := object(source["registration"])
		id := text(product["productId"])
		declaration := object(product["declaration"])
		path := text(object(object(declaration["capabilities"])["suiteMcp"])["path"])
		if path == "" {
			return result, suiteFailure("INVALID_GATEWAY")
		}
		endpoint, e := ResolveSuiteEndpoint(text(object(product["connection"])["baseUrl"]), path)
		if e != nil {
			return result, e
		}
		type original struct {
			definition  JSON
			hash, alias string
		}
		originals := map[string]original{}
		entries := []any{}
		diagnose := func(name, code string) {
			diagnostics = append(diagnostics, JSON{"productId": id, "toolName": name, "code": code})
		}
		for _, entry := range array(source["definitions"]) {
			definition := object(entry)
			tool := object(definition["tool"])
			name := text(tool["name"])
			if _, found := originals[name]; found {
				return result, suiteFailure("INVALID_GATEWAY")
			}
			bundle := JSON{"tool": tool}
			if cli, found := definition["cli"]; found {
				bundle["cli"] = cli
			}
			hash, e := Fingerprint(bundle)
			if e != nil {
				return result, e
			}
			if expected, found := definition["fingerprint"]; found && expected != hash {
				return result, suiteFailure("STALE_DEFINITION")
			}
			alias, e := SuiteToolAlias(id, name)
			if e != nil {
				return result, e
			}
			originals[name] = original{definition, hash, alias}
			catalogEntry := JSON{"name": name, "fingerprint": hash}
			if availability, found := definition["availability"]; found {
				catalogEntry["availability"] = availability
			}
			entries = append(entries, catalogEntry)
		}
		sort.Slice(entries, func(i, j int) bool {
			return utf16Less(text(object(entries[i])["name"]), text(object(entries[j])["name"]))
		})
		catalogPayload := JSON{"serverId": source["serverId"], "viewId": source["viewId"], "tools": entries}
		if presentation, found := source["presentation"]; found {
			catalogPayload["presentation"] = presentation
		}
		sourceCatalog, e := Fingerprint(catalogPayload)
		if e != nil {
			return result, e
		}
		if expected, found := source["catalog"]; found && expected != sourceCatalog {
			return result, suiteFailure("STALE_CATALOG")
		}
		names := map[string]string{}
		for name, value := range originals {
			meta := object(object(value.definition["tool"])["_meta"])
			if _, found := meta["nox/gateway"]; found {
				diagnose(name, "RESERVED_METADATA")
				continue
			}
			policy, found := meta["nox/authorization"]
			if !found {
				diagnose(name, "UNCLASSIFIED_TOOL")
				continue
			}
			encoded, _ := json.Marshal(policy)
			if _, e := LoadSuiteDocument("policy", encoded); e != nil {
				diagnose(name, "INVALID_POLICY")
				continue
			}
			if aliases[value.alias] {
				return result, suiteFailure("INVALID_GATEWAY")
			}
			aliases[value.alias] = true
			names[name] = value.alias
		}
		for name, alias := range names {
			original := originals[name]
			definition := original.definition
			tool := jsonObject(definition["tool"])
			tool["name"] = alias
			meta := object(tool["_meta"])
			meta["nox/gateway"] = JSON{"version": "1.0", "productId": id, "toolName": name, "serverId": source["serverId"], "registrationRevision": product["revision"], "sourceFingerprint": original.hash}
			bundle := JSON{"tool": tool}
			if cli, found := definition["cli"]; found {
				rewritten, e := rewriteSuiteCLI(object(cli), names)
				if e != nil {
					diagnose(name, "INVALID_CLI")
				} else {
					bundle["cli"] = rewritten
				}
			}
			hash, e := Fingerprint(bundle)
			if e != nil {
				return result, e
			}
			aggregate := jsonObject(bundle)
			aggregate["fingerprint"] = hash
			availability := "available"
			if state, found := definition["availability"]; found {
				aggregate["availability"] = state
				availability = text(state)
			}
			definitions = append(definitions, aggregate)
			routes = append(routes, JSON{"alias": alias, "productId": id, "registrationRevision": product["revision"], "associationId": product["associationId"], "serverId": source["serverId"], "viewId": source["viewId"], "toolName": name, "endpoint": endpoint, "sourceFingerprint": original.hash, "fingerprint": hash, "availability": availability})
		}
		components = append(components, JSON{"productId": id, "registrationRevision": product["revision"], "serverId": source["serverId"], "viewId": source["viewId"], "catalog": sourceCatalog})
		presentation := JSON{"productId": id, "displayName": declaration["displayName"]}
		if p, found := source["presentation"]; found {
			presentation["presentation"] = p
		}
		products = append(products, presentation)
		views = append(views, []any{id, product["associationId"], product["revision"], source["serverId"], source["viewId"]})
		if value, found := source["ttlMs"]; found && int64(value.(float64)) < ttl {
			ttl = int64(value.(float64))
		}
	}
	sort.Slice(definitions, func(i, j int) bool {
		return text(object(object(definitions[i])["tool"])["name"]) < text(object(object(definitions[j])["tool"])["name"])
	})
	sort.Slice(routes, func(i, j int) bool { return text(object(routes[i])["alias"]) < text(object(routes[j])["alias"]) })
	sort.Slice(diagnostics, func(i, j int) bool {
		a, b := object(diagnostics[i]), object(diagnostics[j])
		x, _ := Canonicalize([]any{a["productId"], a["toolName"], a["code"]})
		y, _ := Canonicalize([]any{b["productId"], b["toolName"], b["code"]})
		return utf16Less(x, y)
	})
	policyRevision := options.PolicyRevision
	if policyRevision == "" {
		policyRevision = "1.0"
	}
	viewHash, e := Fingerprint(JSON{"authorizationViewId": options.AuthorizationViewID, "policyRevision": policyRevision, "products": views})
	if e != nil {
		return result, e
	}
	viewID := "view-" + viewHash
	presentation := JSON{"gateway": JSON{"version": "1.0", "registryRevision": options.RegistryRevision, "products": components}, "products": products}
	tools := []any{}
	for _, value := range definitions {
		definition := object(value)
		entry := JSON{"name": object(definition["tool"])["name"], "fingerprint": definition["fingerprint"]}
		if availability, found := definition["availability"]; found {
			entry["availability"] = availability
		}
		tools = append(tools, entry)
	}
	catalogHash, e := Fingerprint(JSON{"serverId": options.ServerID, "viewId": viewID, "tools": tools, "presentation": presentation})
	if e != nil {
		return result, e
	}
	catalog := JSON{"resultType": "complete", "serverId": options.ServerID, "viewId": viewID, "tools": tools, "presentation": presentation, "cacheScope": "private", "ttlMs": ttl, "catalog": catalogHash}
	snapshot := JSON{"contractVersion": "1.0", "serverId": options.ServerID, "viewId": viewID, "registryRevision": options.RegistryRevision, "catalog": catalog, "definitions": definitions, "routes": routes, "diagnostics": diagnostics}
	encoded, e := json.Marshal(snapshot)
	if e != nil {
		return result, e
	}
	if _, e = LoadSuiteDocumentWithLimit("gateway-snapshot", encoded, maxBytes); e != nil {
		return result, e
	}
	e = json.Unmarshal(encoded, &result)
	return result, e
}
func SelectSuiteRoute(snapshot SuiteGatewaySnapshot, alias, expectedFingerprint string) (SuiteGatewayRoute, error) {
	for _, route := range snapshot.Routes {
		if route.Alias == alias {
			if expectedFingerprint != "" && route.Fingerprint != expectedFingerprint {
				return SuiteGatewayRoute{}, suiteFailure("STALE_DEFINITION")
			}
			if route.Availability != "available" {
				return SuiteGatewayRoute{}, suiteFailure("UNAVAILABLE")
			}
			encoded, _ := json.Marshal(route)
			var copy SuiteGatewayRoute
			json.Unmarshal(encoded, &copy)
			return copy, nil
		}
	}
	return SuiteGatewayRoute{}, suiteFailure("FORBIDDEN")
}
