package server

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/agrigoryan/quadit/internal/engine"
)

// GET /api/v1/openapi.json: every route described in words, as OpenAPI,
// from the words each route carries.

// openAPIRoutes is the route of the API's description.
func (s *Server) openAPIRoutes() []route {
	return []route{
		{"GET /api/v1/openapi.json", s.handleDescribeAPI, "This document.", "", "describe"},
	}
}

// handleDescribeAPI describes the API as an OpenAPI 3.1 document, built from
// the server's routes (allRoutes) and the engine's catalog of changes.
func (s *Server) handleDescribeAPI(w http.ResponseWriter, _ *http.Request) {
	paths := map[string]map[string]any{}
	for _, rt := range s.allRoutes() {
		method, path, _ := strings.Cut(rt.pattern, " ")
		path = strings.ReplaceAll(path, "...}", "}")
		okAnswer := "JSON."
		if rest, ok := strings.CutPrefix(path, "/api/v1/w/{ws}"); ok {
			path = "/api/v1/w/{workspace}" + rest
			okAnswer = "JSON, or one line per item as text/plain when format=text or Accept: text/plain."
		}
		item := describeOperation(rt, append(pathParams(path), queryParams(rt.query)...), okAnswer)
		if path == "/api/v1/w/{workspace}/changes" {
			item["requestBody"] = map[string]any{"required": true, "content": map[string]any{"application/json": map[string]any{"schema": map[string]any{
				"oneOf": []map[string]string{{"$ref": "#/components/schemas/Change"}, {"$ref": "#/components/schemas/Batch"}}}}}}
		}
		if paths[path] == nil {
			paths[path] = map[string]any{}
		}
		paths[path][strings.ToLower(method)] = item
	}
	doc := map[string]any{
		"openapi": "3.1.0",
		"info": map[string]any{"title": "Quadit API", "version": s.cfg.Version, "description": "One API for people's browsers and for agents. " +
			"Reads return JSON, or compact text with format=text. Every write is a named change sent to /changes. " +
			"Names work wherever ids do: project keys, task keys (SVA-12), @handles, status and label names. " +
			"A refusal has a code, a message, the allowed values and the nearest match. Rate limits answer 429 with Retry-After."},
		"servers":    []map[string]string{{"url": s.cfg.BaseURL}},
		"security":   []map[string][]string{{"token": {}}},
		"paths":      paths,
		"components": apiComponents(),
	}
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", " ")
	enc.Encode(doc)
}

// pathParamWords says what goes in each {name} part of a path, by its name.
var pathParamWords = map[string]string{
	"workspace":  "The workspace's slug, or - for the workspace of the token used.",
	"id":         "The id of the thing the path names: the word before it says what that is (a page, a webhook, a backup…).",
	"name":       "The name of the thing the path names: a cursor's or a secret's own name, a setting's key, or a file's name (for the reader; the id decides).",
	"token":      "The invitation's token: the last part of the link it was sent as.",
	"provider":   "The sign-in provider: google, github or oidc.",
	"collection": "The kind of rows: one of those the summary lists.",
	"key":        "A project's key, such as SVA.",
	"ref":        "A task's key (SVA-12) or id.",
	"version":    "The id of one of the page's kept versions.",
}

// pathParams describes the {name} parts of a path.
func pathParams(path string) []map[string]any {
	params := []map[string]any{}
	for seg := range strings.SplitSeq(path, "/") {
		if strings.HasPrefix(seg, "{") {
			name := strings.Trim(seg, "{}")
			params = append(params, map[string]any{"name": name, "in": "path", "required": true, "schema": map[string]string{"type": "string"},
				"description": pathParamWords[name]})
		}
	}
	return params
}

// queryParams describes the parameters of an operation's Query: "name:
// what it does; name2: …".
func queryParams(query string) []map[string]any {
	var params []map[string]any
	for q := range strings.SplitSeq(query, ";") {
		if name, desc, _ := strings.Cut(strings.TrimSpace(q), ":"); name != "" {
			params = append(params, map[string]any{"name": name, "in": "query", "schema": map[string]string{"type": "string"}, "description": strings.TrimSpace(desc)})
		}
	}
	return params
}

// describeOperation is one operation of the document, answering okAnswer
// when it succeeds and an Error when it does not.
func describeOperation(rt route, params []map[string]any, okAnswer string) map[string]any {
	return map[string]any{"summary": rt.summary, "tags": []string{rt.tag}, "parameters": params,
		"responses": map[string]any{
			"200":     map[string]any{"description": okAnswer},
			"default": map[string]any{"description": "A refusal.", "content": map[string]any{"application/json": map[string]any{"schema": map[string]string{"$ref": "#/components/schemas/Error"}}}},
		}}
}

// apiComponents are the document's shared parts: how to sign in, each
// change type with its arguments, a batch, and the shape of a refusal.
func apiComponents() map[string]any {
	changes := []map[string]any{}
	for _, ci := range engine.Catalog() {
		props := map[string]any{}
		var required []string
		for _, a := range ci.Args {
			props[a.Name] = map[string]string{"description": a.Type}
			if a.Required {
				required = append(required, a.Name)
			}
		}
		args := map[string]any{"type": "object", "properties": props, "additionalProperties": false}
		if len(required) > 0 {
			args["required"] = required
		}
		changes = append(changes, map[string]any{"title": ci.Type, "description": "Least role: " + string(ci.Role), "type": "object", "properties": map[string]any{
			"id":   map[string]string{"type": "string", "description": "A UUID made by the caller."},
			"type": map[string]any{"const": ci.Type},
			"args": args,
		}, "required": []string{"id", "type"}})
	}
	return map[string]any{
		"securitySchemes": map[string]any{"token": map[string]string{"type": "http", "scheme": "bearer", "description": "An API token (qd_…) issued in the workspace's settings."}},
		"schemas": map[string]any{
			"Change": map[string]any{"oneOf": changes},
			"Batch": map[string]any{"type": "object", "properties": map[string]any{"changes": map[string]any{"type": "array", "items": map[string]string{"$ref": "#/components/schemas/Change"}},
				"dry_run": map[string]string{"type": "boolean"}}},
			"Error": map[string]any{"type": "object", "properties": map[string]any{"error": map[string]any{"type": "object", "properties": map[string]any{
				"code":    map[string]any{"enum": []string{"invalid", "forbidden", "not_found", "conflict", "stale", "needs_approval", "budget_exceeded", "unauthorized", "rate_limited"}},
				"message": map[string]string{"type": "string"}, "field": map[string]string{"type": "string"},
				"allowed": map[string]any{"type": "array", "items": map[string]string{"type": "string"}}, "nearest": map[string]string{"type": "string"},
				"index": map[string]string{"type": "integer", "description": "Which change of a batch was refused."}}}}},
		},
	}
}
