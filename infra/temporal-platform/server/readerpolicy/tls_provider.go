package readerpolicy

import (
	"crypto/tls"
	"encoding/asn1"
	"errors"
	"go.temporal.io/server/common/rpc/encryption"
)

type tlsConfigProvider struct {
	encryption.TLSConfigProvider
	subject string
}

var _ encryption.TLSConfigProvider = (*tlsConfigProvider)(nil)

// NewTLSConfigProvider adds a reader identity deny gate to internode TLS.
func NewTLSConfigProvider(delegate encryption.TLSConfigProvider, readerSubject string) (encryption.TLSConfigProvider, error) {
	if delegate == nil || !validSubject(readerSubject) {
		return nil, errors.New("PLATFORM_TEMPORAL_READER_CONFIG_INVALID")
	}
	return &tlsConfigProvider{TLSConfigProvider: delegate, subject: readerSubject}, nil
}

func (p *tlsConfigProvider) GetInternodeServerConfig() (*tls.Config, error) {
	config, err := p.TLSConfigProvider.GetInternodeServerConfig()
	if err != nil {
		return nil, err
	}
	if config == nil {
		return nil, errors.New("PLATFORM_TEMPORAL_INTERNODE_TLS_UNAVAILABLE")
	}
	return p.guard(config), nil
}

func (p *tlsConfigProvider) guard(original *tls.Config) *tls.Config {
	protected := original.Clone()
	priorVerify := original.VerifyConnection
	protected.VerifyConnection = func(state tls.ConnectionState) error {
		// Crypto/tls has already applied the selected native trust roots,
		// ClientAuth and VerifyPeerCertificate. Preserve its extra verifier too.
		if priorVerify != nil {
			if err := priorVerify(state); err != nil {
				return err
			}
		}
		if len(state.PeerCertificates) == 0 || state.PeerCertificates[0] == nil || len(state.VerifiedChains) == 0 {
			return errors.New("PLATFORM_TEMPORAL_INTERNODE_TLS_UNAVAILABLE")
		}
		leaf := state.PeerCertificates[0]
		if leaf.Subject.CommonName == p.subject {
			return errors.New("PLATFORM_TEMPORAL_INTERNODE_READER_DENIED")
		}
		// Also reject a duplicated CN that could otherwise hide the reader value
		// behind pkix.Name.CommonName's final-value representation.
		for _, name := range leaf.Subject.Names {
			if name.Type.Equal(asn1.ObjectIdentifier{2, 5, 4, 3}) && name.Value == p.subject {
				return errors.New("PLATFORM_TEMPORAL_INTERNODE_READER_DENIED")
			}
		}
		return nil
	}
	if original.GetConfigForClient != nil {
		selectConfig := original.GetConfigForClient
		protected.GetConfigForClient = func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
			selected, err := selectConfig(hello)
			if err != nil {
				return nil, err
			}
			if selected == nil {
				return nil, nil
			} // crypto/tls retains the guarded base.
			return p.guard(selected), nil
		}
	}
	return protected
}

// Preserve the native provider's optional ticker/certificate-refresh lifecycle.
func (p *tlsConfigProvider) Close() {
	if closer, ok := p.TLSConfigProvider.(interface{ Close() }); ok {
		closer.Close()
	}
}
