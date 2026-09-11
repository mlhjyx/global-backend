// The managed server uses Temporal's native extensions, not an HTTP proxy or
// a client-side assertion of read-only permission.
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	_ "time/tzdata"

	"global.local/temporal-platform-server/readerpolicy"
	"go.temporal.io/server/common/authorization"
	"go.temporal.io/server/common/config"
	"go.temporal.io/server/common/log"
	"go.temporal.io/server/common/metrics"
	_ "go.temporal.io/server/common/persistence/sql/sqlplugin/postgresql"
	"go.temporal.io/server/common/rpc/encryption"
	"go.temporal.io/server/temporal"
)

func main() {
	os.Exit(Command(os.Args[1:], os.Stderr))
}

// Command reports only a bounded public failure; dependency errors stay private.
func Command(args []string, stderr io.Writer) int {
	if err := run(args); err != nil {
		// Configuration/driver errors can contain rendered secrets. Do not emit
		// those errors, a config dump or a raw JWT from this bootstrap boundary.
		fmt.Fprintln(stderr, "TEMPORAL_PLATFORM_START_UNAVAILABLE")
		return 1
	}
	return 0
}

func run(args []string) error {
	if len(args) != 1 || args[0] != "start" {
		return errors.New("invalid invocation")
	}
	path := os.Getenv("TEMPORAL_SERVER_CONFIG_FILE_PATH")
	if path == "" {
		return errors.New("configuration required")
	}
	cfg, err := config.Load(config.WithConfigFile(path))
	if err != nil {
		return err
	}
	if err = ValidateConfiguration(cfg); err != nil {
		return err
	}
	if err = ValidateTrustDomains(cfg); err != nil {
		return err
	}
	services, err := ParseServices(os.Getenv("TEMPORAL_SERVICES"))
	if err != nil {
		return err
	}
	authorizer, err := readerpolicy.NewAuthorizer(os.Getenv("TEMPORAL_PLATFORM_READER_SUBJECT"))
	if err != nil {
		return err
	}
	logger := log.NewZapLogger(log.BuildZapLogger(cfg.Log))
	metricHandler, err := metrics.MetricsHandlerFromConfig(logger, cfg.Global.Metrics)
	if err != nil {
		return err
	}
	nativeTLS, err := encryption.NewTLSConfigProviderFromConfig(cfg.Global.TLS, metricHandler, logger, nil)
	if err != nil {
		return err
	}
	tlsProvider, err := readerpolicy.NewTLSConfigProvider(nativeTLS, os.Getenv("TEMPORAL_PLATFORM_READER_SUBJECT"))
	if err != nil {
		return err
	}
	if closer, ok := tlsProvider.(interface{ Close() }); ok {
		defer closer.Close()
	}
	// Upstream's permission parser logs malformed claim values. Keep parser
	// values out of logs; key-refresh and request-denial diagnostics remain on
	// their normal loggers. Signature verification is still upstream's mapper.
	delegate := authorization.NewDefaultJWTClaimMapper(
		authorization.NewDefaultTokenKeyProvider(&cfg.Global.Authorization, logger),
		&cfg.Global.Authorization, log.NewNoopLogger(),
	)
	mapper, err := readerpolicy.NewClaimMapper(delegate, os.Getenv("TEMPORAL_PLATFORM_READER_SUBJECT"))
	if err != nil {
		return err
	}
	audience, err := authorization.GetAudienceMapperFromConfig(&cfg.Global.Authorization)
	if err != nil {
		return err
	}
	server, err := temporal.NewServer(
		temporal.ForServices(services), temporal.WithConfig(cfg), temporal.WithLogger(logger),
		temporal.WithTLSConfigFactory(tlsProvider), temporal.WithCustomMetricsHandler(metricHandler),
		temporal.InterruptOn(temporal.InterruptCh()), temporal.WithAuthorizer(authorizer),
		temporal.WithClaimMapper(func(*config.Config) authorization.ClaimMapper { return mapper }),
		temporal.WithAudienceGetter(func(*config.Config) authorization.JWTAudienceMapper { return audience }),
	)
	if err != nil {
		return err
	}
	return server.Start()
}
