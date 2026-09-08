package main

import (
	"errors"
	"net/url"
	"path/filepath"
	"strings"

	"go.temporal.io/server/common/config"
)

var invalidConfiguration = errors.New("TEMPORAL_PLATFORM_CONFIGURATION_INVALID")

// ValidateConfiguration rejects startup paths that would bypass the reader
// authorizer, including unauthenticated access to internal-frontend.
func ValidateConfiguration(cfg *config.Config) error {
	if cfg == nil {
		return invalidConfiguration
	}
	auth := cfg.Global.Authorization
	if auth.Authorizer != "default" || auth.ClaimMapper != "default" || strings.TrimSpace(auth.Audience) == "" ||
		len(auth.JWTKeyProvider.KeySourceURIs) != 1 {
		return invalidConfiguration
	}
	u, err := url.Parse(auth.JWTKeyProvider.KeySourceURIs[0])
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return invalidConfiguration
	}
	for _, group := range []config.GroupTLS{cfg.Global.TLS.Frontend, cfg.Global.TLS.Internode} {
		if group.Client.DisableHostVerification || validateServerTLS(group.Server) != nil {
			return invalidConfiguration
		}
		for _, override := range group.PerHostOverrides {
			if validateServerTLS(override) != nil {
				return invalidConfiguration
			}
		}
	}
	return nil
}

func validateServerTLS(server config.ServerTLS) error {
	if !server.RequireClientAuth || !filepath.IsAbs(server.CertFile) || !filepath.IsAbs(server.KeyFile) ||
		len(server.ClientCAFiles) == 0 || server.CertData != "" || server.KeyData != "" || len(server.ClientCAData) != 0 {
		return invalidConfiguration
	}
	for _, ca := range server.ClientCAFiles {
		if !filepath.IsAbs(ca) {
			return invalidConfiguration
		}
	}
	return nil
}

// ParseServices changes deployment topology only, never permission semantics.
func ParseServices(value string) ([]string, error) {
	if value == "" {
		value = "frontend,internal-frontend,history,matching,worker"
	}
	services := strings.Split(value, ",")
	seen := make(map[string]bool)
	for _, service := range services {
		switch service {
		case "frontend", "internal-frontend", "history", "matching", "worker":
		default:
			return nil, invalidConfiguration
		}
		if seen[service] {
			return nil, invalidConfiguration
		}
		seen[service] = true
	}
	return services, nil
}
