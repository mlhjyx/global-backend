package main

import (
	"bytes"
	"crypto/sha256"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"io"
	"os"
	"path/filepath"
	"syscall"

	"go.temporal.io/server/common/config"
)

const (
	maxTrustCAFileBytes  = 64 * 1024
	maxTrustCAFiles      = 64
	maxTrustCertificates = 128
	maxTrustParentDepth  = 128
)

var invalidTrustDomains = errors.New("TEMPORAL_PLATFORM_TRUST_DOMAINS_INVALID")

// ValidateTrustDomains checks snapshots of configured public client CAs, never
// certificate private keys. It detects shared keys and known cross-sign chains,
// not chains that have never been configured. Secret mounts and controlled
// atomic operator rotation remain required: this startup check does not protect
// against a malicious root/euid or an uncontrolled future hot reload.
func ValidateTrustDomains(cfg *config.Config) error {
	if cfg == nil {
		return invalidTrustDomains
	}
	frontend, err := trustDomainCertificates(cfg.Global.TLS.Frontend, true)
	if err != nil {
		return invalidTrustDomains
	}
	internode, err := trustDomainCertificates(cfg.Global.TLS.Internode, false)
	if err != nil {
		return invalidTrustDomains
	}
	keys := make(map[[32]byte]bool, len(frontend))
	for _, certificate := range frontend {
		spki, err := x509.MarshalPKIXPublicKey(certificate.PublicKey)
		if err != nil {
			return invalidTrustDomains
		}
		keys[sha256.Sum256(spki)] = true
	}
	for _, certificate := range internode {
		spki, err := x509.MarshalPKIXPublicKey(certificate.PublicKey)
		if err != nil || keys[sha256.Sum256(spki)] {
			return invalidTrustDomains
		}
	}
	known := x509.NewCertPool()
	frontRoots, internalRoots := x509.NewCertPool(), x509.NewCertPool()
	for _, certificate := range frontend {
		known.AddCert(certificate)
		frontRoots.AddCert(certificate)
	}
	for _, certificate := range internode {
		known.AddCert(certificate)
		internalRoots.AddCert(certificate)
	}
	for _, domain := range []struct {
		certificates []*x509.Certificate
		peerRoots    *x509.CertPool
	}{
		{frontend, internalRoots}, {internode, frontRoots},
	} {
		for _, certificate := range domain.certificates {
			if _, err := certificate.Verify(x509.VerifyOptions{Roots: domain.peerRoots, Intermediates: known,
				KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny}}); err == nil {
				return invalidTrustDomains
			}
		}
	}
	// Conservatively reject known signing bridges even when a staged/expired CA
	// makes today's Verify fail. Any path among the configured CAs that crosses
	// the domains must contain a cross-domain signature edge. This does not infer
	// signatures or intermediates that are absent from these configured files.
	for _, front := range frontend {
		for _, internal := range internode {
			if front.CheckSignatureFrom(internal) == nil || internal.CheckSignatureFrom(front) == nil {
				return invalidTrustDomains
			}
		}
	}
	return nil
}

func trustDomainCertificates(group config.GroupTLS, allowJwtOnly bool) ([]*x509.Certificate, error) {
	if len(group.PerHostOverrides) > maxTrustCAFiles {
		return nil, invalidTrustDomains
	}
	servers := []config.ServerTLS{group.Server}
	for _, override := range group.PerHostOverrides {
		servers = append(servers, override)
	}
	files := make(map[string]bool)
	var certificates []*x509.Certificate
	jwtOnlyNoTrustDomain := false
	for index, server := range servers {
		if len(server.ClientCAFiles) == 0 {
			// The public frontend is explicitly allowed to use JWT-only auth;
			// it has no client-CA trust domain in that mode. Internode and an
			// explicitly mTLS-enabled frontend still require a bounded CA set.
			if allowJwtOnly && index == 0 && !server.RequireClientAuth && len(server.ClientCAData) == 0 {
				jwtOnlyNoTrustDomain = true
				continue
			}
			return nil, invalidTrustDomains
		}
		if len(server.ClientCAFiles) > maxTrustCAFiles || len(server.ClientCAData) != 0 {
			return nil, invalidTrustDomains
		}
		for _, path := range server.ClientCAFiles {
			if files[path] {
				continue
			}
			if len(files) >= maxTrustCAFiles {
				return nil, invalidTrustDomains
			}
			files[path] = true
			contents, err := readTrustCAFile(path)
			if err != nil {
				return nil, invalidTrustDomains
			}
			parsed, err := parseTrustCAs(contents)
			if err != nil || len(certificates)+len(parsed) > maxTrustCertificates {
				return nil, invalidTrustDomains
			}
			certificates = append(certificates, parsed...)
		}
	}
	if len(certificates) == 0 && !jwtOnlyNoTrustDomain {
		return nil, invalidTrustDomains
	}
	return certificates, nil
}

func parseTrustCAs(contents []byte) ([]*x509.Certificate, error) {
	begin, end := []byte("-----BEGIN CERTIFICATE-----"), []byte("-----END CERTIFICATE-----")
	var certificates []*x509.Certificate
	for contents = bytes.TrimSpace(contents); len(contents) != 0; contents = bytes.TrimSpace(contents) {
		if !bytes.HasPrefix(contents, begin) || len(certificates) >= maxTrustCertificates {
			return nil, invalidTrustDomains
		}
		endIndex := bytes.Index(contents, end)
		if endIndex < 0 {
			return nil, invalidTrustDomains
		}
		segment := contents[:endIndex+len(end)]
		// pem.Decode can skip malformed leading blocks. Limit it to exactly the
		// first block so malformed+valid concatenations cannot be silently accepted.
		if bytes.Contains(segment[len(begin):], []byte("-----BEGIN")) {
			return nil, invalidTrustDomains
		}
		block, rest := pem.Decode(segment)
		if block == nil || block.Type != "CERTIFICATE" || len(block.Headers) != 0 || len(bytes.TrimSpace(rest)) != 0 {
			return nil, invalidTrustDomains
		}
		certificate, err := x509.ParseCertificate(block.Bytes)
		if err != nil || !certificate.BasicConstraintsValid || !certificate.IsCA || len(certificate.UnhandledCriticalExtensions) != 0 ||
			(certificate.KeyUsage != 0 && certificate.KeyUsage&x509.KeyUsageCertSign == 0) {
			return nil, invalidTrustDomains
		}
		certificates = append(certificates, certificate)
		contents = contents[len(segment):]
	}
	if len(certificates) == 0 {
		return nil, invalidTrustDomains
	}
	return certificates, nil
}

type trustPathSnapshot struct {
	path string
	info os.FileInfo
}

func trustedTrustOwner(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && (stat.Uid == 0 || stat.Uid == uint32(os.Geteuid()))
}

func sameTrustIdentity(first, second os.FileInfo) bool {
	a, aOK := first.Sys().(*syscall.Stat_t)
	b, bOK := second.Sys().(*syscall.Stat_t)
	return aOK && bOK && os.SameFile(first, second) && first.Mode() == second.Mode() && a.Uid == b.Uid && a.Gid == b.Gid
}

func sameTrustFile(first, second os.FileInfo) bool {
	if !sameTrustIdentity(first, second) || first.Size() != second.Size() || !first.ModTime().Equal(second.ModTime()) {
		return false
	}
	return first.Sys().(*syscall.Stat_t).Ctim == second.Sys().(*syscall.Stat_t).Ctim
}

func trustParentSnapshots(path string) ([]trustPathSnapshot, error) {
	var names []string
	for parent := filepath.Dir(path); ; parent = filepath.Dir(parent) {
		if len(names) >= maxTrustParentDepth {
			return nil, invalidTrustDomains
		}
		names = append(names, parent)
		if parent == string(os.PathSeparator) {
			break
		}
	}
	var snapshots []trustPathSnapshot
	for index := len(names) - 1; index >= 0; index-- {
		info, err := os.Lstat(names[index])
		if err != nil || !info.IsDir() || !trustedTrustOwner(info) ||
			(info.Mode().Perm()&0022 != 0 && info.Mode()&os.ModeSticky == 0) {
			return nil, invalidTrustDomains
		}
		snapshots = append(snapshots, trustPathSnapshot{names[index], info})
	}
	return snapshots, nil
}

func validTrustCAFile(info os.FileInfo) bool {
	return info.Mode().IsRegular() && trustedTrustOwner(info) && info.Mode().Perm()&0022 == 0 &&
		info.Size() > 0 && info.Size() <= maxTrustCAFileBytes
}

func readTrustCAFile(path string) ([]byte, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || len(path) > 4096 {
		return nil, invalidTrustDomains
	}
	parents, err := trustParentSnapshots(path)
	if err != nil {
		return nil, invalidTrustDomains
	}
	pathBefore, err := os.Lstat(path)
	if err != nil || !validTrustCAFile(pathBefore) {
		return nil, invalidTrustDomains
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, invalidTrustDomains
	}
	file := os.NewFile(uintptr(fd), path)
	defer func() { _ = file.Close() }() // Read-only descriptor, no buffered writes to flush.
	before, err := file.Stat()
	if err != nil || !validTrustCAFile(before) || !sameTrustFile(pathBefore, before) {
		return nil, invalidTrustDomains
	}
	contents, err := io.ReadAll(io.LimitReader(file, maxTrustCAFileBytes+1))
	if err != nil || int64(len(contents)) != before.Size() || len(contents) > maxTrustCAFileBytes {
		return nil, invalidTrustDomains
	}
	after, err := file.Stat()
	if err != nil || !sameTrustFile(before, after) {
		return nil, invalidTrustDomains
	}
	pathAfter, err := os.Lstat(path)
	if err != nil || !sameTrustFile(before, pathAfter) {
		return nil, invalidTrustDomains
	}
	for _, parent := range parents {
		current, err := os.Lstat(parent.path)
		// Directory size/mtime can change for unrelated entries (notably /tmp).
		if err != nil || !sameTrustIdentity(parent.info, current) {
			return nil, invalidTrustDomains
		}
	}
	return contents, nil
}
