package readerpolicy_test

import (
	"context"
	"crypto/rsa"
	"github.com/golang-jwt/jwt/v4"
	"global.local/temporal-platform-server/readerpolicy"
	enumspb "go.temporal.io/api/enums/v1"
	tq "go.temporal.io/api/taskqueue/v1"
	ws "go.temporal.io/api/workflowservice/v1"
	tokenspb "go.temporal.io/server/api/token/v1"
	"go.temporal.io/server/common/authorization"
	"go.temporal.io/server/common/tasktoken"
	"google.golang.org/grpc/credentials"
	hp "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/peer"
	"reflect"
	"strings"
	"testing"
	"time"
)

// The old non-reader passthrough accepts an unprofiled worker credential.
func TestMachineWorkerRejectsUnprofiledCredential(t *testing.T) {
	provider, mapper, _ := machineSetup(t)
	_, err := mapper.GetClaims(&authorization.AuthInfo{AuthToken: token(t, provider.key, "backend-platform-worker", []string{"platform-automation:worker"}), Audience: "temporal-platform"})
	if err == nil {
		t.Fatal("unprofiled worker credential accepted")
	}
}

func signedMachine(t *testing.T, k *rsa.PrivateKey, subject, profile string, permissions []string, mutate func(jwt.MapClaims, map[string]any)) string {
	t.Helper()
	now := time.Now().Unix()
	c := jwt.MapClaims{"iss": "https://growthos.example/temporal-runtime", "aud": "temporal-platform", "sub": subject, "profile": profile, "jti": "12345678-1234-4234-8234-123456789abc", "iat": now - 1, "nbf": now - 1, "exp": now + 299, "permissions": permissions}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, c)
	tok.Header["kid"] = "test-jwt"
	tok.Header["typ"] = "temporal-runtime+jwt"
	if mutate != nil {
		mutate(c, tok.Header)
	}
	s, e := tok.SignedString(k)
	if e != nil {
		t.Fatal(e)
	}
	return "Bearer " + s
}

func TestMachineWorkerRPCMatrix(t *testing.T) {
	k, m, a := machineSetup(t)
	for _, profile := range []struct{ sub, profile, ns string }{{"backend-platform-worker", "temporal-platform-worker", "platform-automation"}, {"backend-customer-worker", "temporal-customer-worker", "default"}} {
		t.Run(profile.profile, func(t *testing.T) {
			c, e := m.GetClaims(&authorization.AuthInfo{AuthToken: signedMachine(t, k.key, profile.sub, profile.profile, []string{profile.ns + ":worker"}, nil), Audience: "temporal-platform"})
			if e != nil {
				t.Fatal(e)
			}
			identity := profile.sub + ":12345678-1234-4234-8234-123456789abc"
			sticky := identity + "-12345678123442348234123456789abc"
			normal := &tq.TaskQueue{Name: "understanding"}
			sq := &tq.TaskQueue{Name: sticky, NormalName: "understanding", Kind: enumspb.TASK_QUEUE_KIND_STICKY}
			raw, e := tasktoken.NewSerializer().Serialize(&tokenspb.Task{NamespaceId: "namespace-id", WorkflowId: "workflow", RunId: "run", ScheduledEventId: 1})
			if e != nil {
				t.Fatal(e)
			}
			query, _ := tasktoken.NewSerializer().SerializeQueryTaskToken(&tokenspb.QueryTask{NamespaceId: "namespace-id", TaskQueue: "understanding", TaskId: "query"})
			requests := []any{
				&ws.PollWorkflowTaskQueueRequest{Namespace: profile.ns, Identity: identity, TaskQueue: normal}, &ws.PollWorkflowTaskQueueRequest{Namespace: profile.ns, Identity: identity, TaskQueue: sq}, &ws.PollActivityTaskQueueRequest{Namespace: profile.ns, Identity: identity, TaskQueue: normal},
				&ws.RespondWorkflowTaskCompletedRequest{Namespace: profile.ns, Identity: identity, TaskToken: raw, StickyAttributes: &tq.StickyExecutionAttributes{WorkerTaskQueue: sq}}, &ws.RespondWorkflowTaskFailedRequest{Namespace: profile.ns, Identity: identity, TaskToken: raw}, &ws.RespondQueryTaskCompletedRequest{Namespace: profile.ns, TaskToken: query},
				&ws.RecordActivityTaskHeartbeatRequest{Namespace: profile.ns, Identity: identity, TaskToken: raw}, &ws.RecordActivityTaskHeartbeatByIdRequest{Namespace: profile.ns, Identity: identity},
				&ws.RespondActivityTaskCompletedRequest{Namespace: profile.ns, Identity: identity, TaskToken: raw}, &ws.RespondActivityTaskCompletedByIdRequest{Namespace: profile.ns, Identity: identity}, &ws.RespondActivityTaskFailedRequest{Namespace: profile.ns, Identity: identity, TaskToken: raw}, &ws.RespondActivityTaskFailedByIdRequest{Namespace: profile.ns, Identity: identity}, &ws.RespondActivityTaskCanceledRequest{Namespace: profile.ns, Identity: identity, TaskToken: raw}, &ws.RespondActivityTaskCanceledByIdRequest{Namespace: profile.ns, Identity: identity},
				&ws.GetWorkflowExecutionHistoryRequest{Namespace: profile.ns}, &ws.ResetStickyTaskQueueRequest{Namespace: profile.ns}, &ws.ShutdownWorkerRequest{Namespace: profile.ns, Identity: identity, TaskQueue: "understanding", StickyTaskQueue: sticky}, &ws.RecordWorkerHeartbeatRequest{Namespace: profile.ns, Identity: identity},
			}
			for _, r := range requests {
				name := reflect.TypeOf(r).Elem().Name()
				method := name[:len(name)-len("Request")]
				target := &authorization.CallTarget{Namespace: profile.ns, APIName: prefix + method, Request: r}
				result, e := a.Authorize(context.Background(), c, target)
				if e != nil || result.Decision != authorization.DecisionAllow {
					t.Fatalf("%s rejected: %v", name, e)
				}
				target.Namespace = "other"
				result, _ = a.Authorize(context.Background(), c, target)
				if result.Decision != authorization.DecisionDeny {
					t.Fatalf("%s crossed namespace", name)
				}
			}
			for _, method := range []string{"StartWorkflowExecution", "CreateSchedule", "UpdateSchedule", "PatchSchedule", "DeleteSchedule", "TerminateWorkflowExecution", "RequestCancelWorkflowExecution", "ListWorkflowExecutions", "DescribeWorkflowExecution", "QueryWorkflow", "SignalWorkflowExecution", "RegisterNamespace", "StartActivityExecution", "ExecuteMultiOperation", "PollNexusTaskQueue"} {
				result, _ := a.Authorize(context.Background(), c, &authorization.CallTarget{Namespace: profile.ns, APIName: prefix + method, Request: &ws.StartWorkflowExecutionRequest{Namespace: profile.ns}})
				if result.Decision != authorization.DecisionDeny {
					t.Fatalf("forbidden %s allowed", method)
				}
			}
			for _, tc := range []struct {
				name   string
				target *authorization.CallTarget
				allow  bool
			}{
				{"system info", &authorization.CallTarget{APIName: prefix + "GetSystemInfo", Request: &ws.GetSystemInfoRequest{}}, true},
				{"health", &authorization.CallTarget{APIName: "/grpc.health.v1.Health/Check", Request: &hp.HealthCheckRequest{}}, true},
				{"health wrong namespace", &authorization.CallTarget{Namespace: profile.ns, APIName: "/grpc.health.v1.Health/Check", Request: &hp.HealthCheckRequest{}}, false},
				{"wrong type", &authorization.CallTarget{APIName: prefix + "GetSystemInfo", Request: &hp.HealthCheckRequest{}}, false},
				{"wrong queue", &authorization.CallTarget{Namespace: profile.ns, APIName: prefix + "PollWorkflowTaskQueue", Request: &ws.PollWorkflowTaskQueueRequest{Namespace: profile.ns, Identity: identity, TaskQueue: &tq.TaskQueue{Name: "other"}}}, false},
				{"wrong sticky owner", &authorization.CallTarget{Namespace: profile.ns, APIName: prefix + "PollWorkflowTaskQueue", Request: &ws.PollWorkflowTaskQueueRequest{Namespace: profile.ns, Identity: identity, TaskQueue: &tq.TaskQueue{Name: "other-12345678123442348234123456789abc", NormalName: "understanding", Kind: enumspb.TASK_QUEUE_KIND_STICKY}}}, false},
				{"malformed token", &authorization.CallTarget{Namespace: profile.ns, APIName: prefix + "RespondWorkflowTaskCompleted", Request: &ws.RespondWorkflowTaskCompletedRequest{Namespace: profile.ns, Identity: identity, TaskToken: []byte("bad")}}, false},
			} {
				r, e := a.Authorize(context.Background(), c, tc.target)
				if e != nil || (r.Decision == authorization.DecisionAllow) != tc.allow {
					t.Fatalf("%s decision wrong", tc.name)
				}
			}
		})
	}
}

func TestMachineReaderRetainsTLSAndThreeRPCs(t *testing.T) {
	k, m, a := machineSetup(t)
	raw := signedMachine(t, k.key, reader, "temporal-reader", []string{"platform-automation:read"}, nil)
	c, e := m.GetClaims(&authorization.AuthInfo{AuthToken: raw, Audience: "temporal-platform", TLSConnection: verifiedTLS(t, reader, false)})
	if e != nil {
		t.Fatal(e)
	}
	r, e := a.Authorize(context.Background(), c, &authorization.CallTarget{Namespace: namespace, APIName: prefix + "DescribeSchedule", Request: &ws.DescribeScheduleRequest{Namespace: namespace}})
	if e != nil || r.Decision != authorization.DecisionAllow {
		t.Fatal("reader rejected")
	}
	r, _ = a.Authorize(context.Background(), c, &authorization.CallTarget{APIName: prefix + "GetSystemInfo", Request: &ws.GetSystemInfoRequest{}})
	if r.Decision != authorization.DecisionDeny {
		t.Fatal("reader health widened")
	}
	_, e = m.GetClaims(&authorization.AuthInfo{AuthToken: raw, Audience: "temporal-platform"})
	if e == nil {
		t.Fatal("reader without TLS accepted")
	}
}

func TestMachineCustomerClientAndProvisioning(t *testing.T) {
	k, m, a := machineSetup(t)
	c, e := m.GetClaims(&authorization.AuthInfo{AuthToken: signedMachine(t, k.key, "backend-customer-client", "temporal-customer-client", []string{"default:read", "default:write"}, nil), Audience: "temporal-platform"})
	if e != nil {
		t.Fatal(e)
	}
	for _, r := range []any{&ws.StartWorkflowExecutionRequest{Namespace: "default", TaskQueue: &tq.TaskQueue{Name: "understanding"}}, &ws.DescribeWorkflowExecutionRequest{Namespace: "default"}, &ws.GetWorkflowExecutionHistoryRequest{Namespace: "default"}, &ws.RequestCancelWorkflowExecutionRequest{Namespace: "default"}} {
		name := reflect.TypeOf(r).Elem().Name()
		result, _ := a.Authorize(context.Background(), c, &authorization.CallTarget{Namespace: "default", APIName: prefix + name[:len(name)-7], Request: r})
		if result.Decision != authorization.DecisionAllow {
			t.Fatalf("client %s rejected", name)
		}
	}
	r, _ := a.Authorize(context.Background(), c, &authorization.CallTarget{Namespace: "default", APIName: prefix + "CreateSchedule", Request: &ws.CreateScheduleRequest{Namespace: "default"}})
	if r.Decision != authorization.DecisionDeny {
		t.Fatal("client schedule allowed")
	}
	for _, p := range []struct {
		sub         string
		permissions []string
	}{{"provision-admin", []string{"temporal-system:admin"}}, {"schedule-writer", []string{"platform-automation:write"}}} {
		c, e = m.GetClaims(&authorization.AuthInfo{AuthToken: token(t, k.key, p.sub, p.permissions), Audience: "temporal-platform"})
		if e != nil {
			t.Fatalf("independent %s rejected: %v", p.sub, e)
		}
		r, _ = a.Authorize(context.Background(), c, &authorization.CallTarget{Namespace: namespace, APIName: prefix + "CreateSchedule", Request: &ws.CreateScheduleRequest{Namespace: namespace}})
		if r.Decision != authorization.DecisionAllow {
			t.Fatal("provision boundary rejected")
		}
	}
}

func TestMachineRejectsInvalidBoundary(t *testing.T) {
	provider, mapper, _ := machineSetup(t)
	for _, tc := range []struct {
		name   string
		mutate func(jwt.MapClaims)
	}{
		{"wrong issuer", func(c jwt.MapClaims) { c["iss"] = "other" }},
		{"missing jti", func(c jwt.MapClaims) { delete(c, "jti") }},
		{"extra permission", func(c jwt.MapClaims) {
			c["permissions"] = []string{"platform-automation:worker", "platform-automation:write"}
		}},
		{"unknown profile", func(c jwt.MapClaims) { c["profile"] = "admin" }},
		{"extra claim", func(c jwt.MapClaims) { c["scope"] = "admin" }},
		{"fractional time", func(c jwt.MapClaims) { c["iat"] = float64(time.Now().Unix()) - 0.5 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Now().Unix()
			c := jwt.MapClaims{"iss": "https://growthos.example/temporal-runtime", "aud": "temporal-platform", "sub": "backend-platform-worker", "profile": "temporal-platform-worker", "jti": "12345678-1234-4234-8234-123456789abc", "iat": now - 1, "nbf": now - 1, "exp": now + 299, "permissions": []string{"platform-automation:worker"}}
			tc.mutate(c)
			tok := jwt.NewWithClaims(jwt.SigningMethodRS256, c)
			tok.Header["kid"] = "test-jwt"
			tok.Header["typ"] = "temporal-runtime+jwt"
			signed, err := tok.SignedString(provider.key)
			if err != nil {
				t.Fatal(err)
			}
			_, err = mapper.GetClaims(&authorization.AuthInfo{AuthToken: "Bearer " + signed, Audience: "temporal-platform"})
			if err == nil {
				t.Fatal("invalid machine boundary accepted")
			}
		})
	}
}

func machineConfig() readerpolicy.MachineConfig {
	return readerpolicy.MachineConfig{Issuer: "https://growthos.example/temporal-runtime", Audience: "temporal-platform", ReaderSubject: reader, PlatformWorkerSubject: "backend-platform-worker", CustomerWorkerSubject: "backend-customer-worker", CustomerClientSubject: "backend-customer-client", ProvisionAdminSubject: "provision-admin", ScheduleWriterSubject: "schedule-writer"}
}
func machineSetup(t *testing.T) (keys, authorization.ClaimMapper, authorization.Authorizer) {
	t.Helper()
	k, m, a := setup(t)
	m, e := readerpolicy.NewMachineClaimMapper(m, machineConfig())
	if e != nil {
		t.Fatal(e)
	}
	a, e = readerpolicy.NewMachineAuthorizer(a, machineConfig())
	if e != nil {
		t.Fatal(e)
	}
	return k, m, a
}

func TestMachineStrictHeadersTimesRolesAndConfiguration(t *testing.T) {
	k, m, a := machineSetup(t)
	for _, tc := range []struct {
		name   string
		mutate func(jwt.MapClaims, map[string]any)
	}{
		{"wrong typ", func(c jwt.MapClaims, h map[string]any) { h["typ"] = "JWT" }},
		{"extra header", func(c jwt.MapClaims, h map[string]any) { h["jku"] = "https://evil.invalid" }},
		{"missing kid", func(c jwt.MapClaims, h map[string]any) { delete(h, "kid") }},
		{"wrong subject", func(c jwt.MapClaims, h map[string]any) { c["sub"] = "unknown-worker" }},
		{"wrong namespace", func(c jwt.MapClaims, h map[string]any) { c["permissions"] = []string{"default:worker"} }},
		{"system admin", func(c jwt.MapClaims, h map[string]any) { c["permissions"] = []string{"temporal-system:admin"} }},
		{"duplicate permission", func(c jwt.MapClaims, h map[string]any) {
			c["permissions"] = []string{"platform-automation:worker", "platform-automation:worker"}
		}},
		{"ignored permission", func(c jwt.MapClaims, h map[string]any) { c["permissions"] = []any{"platform-automation:worker", 1} }},
		{"aud array", func(c jwt.MapClaims, h map[string]any) { c["aud"] = []string{"temporal-platform"} }},
		{"wrong profile subject", func(c jwt.MapClaims, h map[string]any) { c["profile"] = "temporal-customer-worker" }},
		{"non uuid jti", func(c jwt.MapClaims, h map[string]any) { c["jti"] = "not-uuid" }},
		{"missing exp", func(c jwt.MapClaims, h map[string]any) { delete(c, "exp") }},
		{"expired", func(c jwt.MapClaims, h map[string]any) { c["exp"] = time.Now().Unix() }},
		{"long ttl", func(c jwt.MapClaims, h map[string]any) { c["exp"] = time.Now().Unix() + 600 }},
		{"future issued", func(c jwt.MapClaims, h map[string]any) { c["iat"] = time.Now().Unix() + 61 }},
		{"wrong nbf", func(c jwt.MapClaims, h map[string]any) { c["nbf"] = time.Now().Unix() - 50 }},
		{"negative iat", func(c jwt.MapClaims, h map[string]any) { c["iat"] = -1 }},
		{"string exp", func(c jwt.MapClaims, h map[string]any) { c["exp"] = "2000000000" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := m.GetClaims(&authorization.AuthInfo{AuthToken: signedMachine(t, k.key, "backend-platform-worker", "temporal-platform-worker", []string{"platform-automation:worker"}, tc.mutate), Audience: "temporal-platform"})
			if err == nil {
				t.Fatal("invalid machine accepted")
			}
		})
	}
	for _, info := range []*authorization.AuthInfo{nil, {}, {AuthToken: strings.Repeat("x", 16401), Audience: "temporal-platform"}, {AuthToken: "Bearer malformed", Audience: "temporal-platform"}} {
		if _, err := m.GetClaims(info); err == nil {
			t.Fatal("malformed input accepted")
		}
	}
	for _, mutate := range []func(*readerpolicy.MachineConfig){func(c *readerpolicy.MachineConfig) { c.Issuer = "http://issuer" }, func(c *readerpolicy.MachineConfig) { c.Audience = "" }, func(c *readerpolicy.MachineConfig) { c.CustomerWorkerSubject = c.PlatformWorkerSubject }, func(c *readerpolicy.MachineConfig) { c.ProvisionAdminSubject = "" }} {
		cfg := machineConfig()
		mutate(&cfg)
		if _, e := readerpolicy.NewMachineClaimMapper(m, cfg); e == nil {
			t.Fatal("invalid mapper configuration accepted")
		}
		if _, e := readerpolicy.NewMachineAuthorizer(a, cfg); e == nil {
			t.Fatal("invalid authorizer configuration accepted")
		}
	}
	if _, e := readerpolicy.NewMachineClaimMapper(nil, machineConfig()); e == nil {
		t.Fatal("nil delegate accepted")
	}
	if _, e := readerpolicy.NewMachineAuthorizer(nil, machineConfig()); e == nil {
		t.Fatal("nil authorizer accepted")
	}
	forged := &authorization.Claims{Subject: "backend-platform-worker", AuthType: "jwt", Namespaces: map[string]authorization.Role{namespace: authorization.RoleWorker}, Extensions: map[string]any{"profile": "temporal-platform-worker"}}
	r, _ := a.Authorize(context.Background(), forged, &authorization.CallTarget{APIName: prefix + "GetSystemInfo", Request: &ws.GetSystemInfoRequest{}})
	if r.Decision != authorization.DecisionDeny {
		t.Fatal("JWT extension forged typed proof")
	}
	r, _ = a.Authorize(context.Background(), nil, nil)
	if r.Decision != authorization.DecisionDeny {
		t.Fatal("nil claims allowed")
	}
}

func TestMachineAcceptsCanonicalUUIDAndBoundedNotBefore(t *testing.T) {
	k, m, _ := machineSetup(t)
	raw := signedMachine(t, k.key, "backend-platform-worker", "temporal-platform-worker", []string{"platform-automation:worker"}, func(c jwt.MapClaims, h map[string]any) {
		now := time.Now().Unix()
		c["iat"] = now - 5
		c["nbf"] = now - 2
		c["exp"] = now + 295
		c["jti"] = "12345678-1234-7234-8234-123456789abc"
	})
	if _, err := m.GetClaims(&authorization.AuthInfo{AuthToken: raw, Audience: "temporal-platform"}); err != nil {
		t.Fatal("canonical UUIDv7 and bounded nbf rejected")
	}
}

func TestMachineRejectsNonCanonicalCompactSignature(t *testing.T) {
	k, m, _ := machineSetup(t)
	raw := signedMachine(t, k.key, "backend-platform-worker", "temporal-platform-worker", []string{"platform-automation:worker"}, nil)
	alphabet := "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	last := strings.IndexByte(alphabet, raw[len(raw)-1])
	if last%16 != 0 {
		t.Fatal("RSA2048 fixture signature did not have four unused base64 bits")
	}
	raw = raw[:len(raw)-1] + string(alphabet[last+1])
	if _, err := m.GetClaims(&authorization.AuthInfo{AuthToken: raw, Audience: "temporal-platform"}); err == nil {
		t.Fatal("noncanonical compact signature accepted")
	}
}

func TestWorkerCannotRegisterNormalQueueAsStickyQueue(t *testing.T) {
	k, m, a := machineSetup(t)
	c, e := m.GetClaims(&authorization.AuthInfo{AuthToken: signedMachine(t, k.key, "backend-platform-worker", "temporal-platform-worker", []string{"platform-automation:worker"}, nil), Audience: "temporal-platform"})
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := tasktoken.NewSerializer().Serialize(&tokenspb.Task{NamespaceId: "namespace-id", WorkflowId: "workflow", RunId: "run", ScheduledEventId: 1})
	r, _ := a.Authorize(context.Background(), c, &authorization.CallTarget{Namespace: namespace, APIName: prefix + "RespondWorkflowTaskCompleted", Request: &ws.RespondWorkflowTaskCompletedRequest{Namespace: namespace, Identity: "backend-platform-worker:12345678-1234-4234-8234-123456789abc", TaskToken: raw, StickyAttributes: &tq.StickyExecutionAttributes{WorkerTaskQueue: &tq.TaskQueue{Name: "understanding"}}}})
	if r.Decision != authorization.DecisionDeny {
		t.Fatal("normal queue accepted as worker-owned sticky queue")
	}
}

func TestNativeUnauthenticatedHealthBaselineDoesNotGrantWork(t *testing.T) {
	_, m, a := machineSetup(t)
	c, e := m.GetClaims(&authorization.AuthInfo{Audience: "temporal-platform", TLSConnection: verifiedTLS(t, "temporal-internode", false)})
	if e != nil {
		t.Fatal("native internode health claims rejected")
	}
	for _, claims := range []*authorization.Claims{nil, c} {
		for _, target := range []*authorization.CallTarget{{APIName: prefix + "GetSystemInfo", Request: &ws.GetSystemInfoRequest{}}, {APIName: "/grpc.health.v1.Health/Check", Request: &hp.HealthCheckRequest{}}} {
			r, e := a.Authorize(context.Background(), claims, target)
			if e != nil || r.Decision != authorization.DecisionAllow {
				t.Fatal("native empty-token health baseline rejected")
			}
		}
		for _, target := range []*authorization.CallTarget{{Namespace: namespace, APIName: prefix + "PollWorkflowTaskQueue", Request: &ws.PollWorkflowTaskQueueRequest{Namespace: namespace}}, {Namespace: namespace, APIName: prefix + "GetSystemInfo", Request: &ws.GetSystemInfoRequest{}}, {APIName: prefix + "GetSystemInfo", Request: &hp.HealthCheckRequest{}}} {
			r, _ := a.Authorize(context.Background(), claims, target)
			if r.Decision != authorization.DecisionDeny {
				t.Fatal("empty-token health exception granted work or mismatched request")
			}
		}
	}
}

func TestMachineIssuerMatchesExistingAuthorityIdentifierContract(t *testing.T) {
	_, m, _ := setup(t)
	for _, issuer := range []string{"http://localhost:8080/temporal-runtime", "http://127.0.0.1:8080/temporal-runtime", "https://issuer.example/" + strings.Repeat("x", 1000)} {
		c := machineConfig()
		c.Issuer = issuer
		if _, e := readerpolicy.NewMachineClaimMapper(m, c); e != nil {
			t.Fatal("existing issuer identifier contract rejected")
		}
	}
}

func TestOfficialInternodeMapperRetainsVerifiedTLSBoundary(t *testing.T) {
	k, m, a := machineSetup(t)
	internal, e := authorization.NewInternalClaimMapper().GetClaims(&authorization.AuthInfo{})
	if e != nil {
		t.Fatal(e)
	}
	target := &authorization.CallTarget{Namespace: namespace, APIName: prefix + "StartWorkflowExecution", Request: &ws.StartWorkflowExecutionRequest{Namespace: namespace}}
	tls := verifiedTLS(t, "temporal-internode", false)
	ctx := peer.NewContext(context.Background(), &peer.Peer{AuthInfo: *tls})
	r, e := a.Authorize(ctx, internal, target)
	if e != nil || r.Decision != authorization.DecisionAllow {
		t.Fatal("official internode mTLS principal rejected")
	}
	readerTLS := verifiedTLS(t, reader, false)
	for _, bad := range []context.Context{context.Background(), peer.NewContext(context.Background(), &peer.Peer{AuthInfo: *readerTLS}), peer.NewContext(context.Background(), &peer.Peer{AuthInfo: *verifiedJwtOnlyTLS()})} {
		r, _ := a.Authorize(bad, internal, target)
		if r.Decision != authorization.DecisionDeny {
			t.Fatal("internal authority granted without non-reader verified peer")
		}
	}
	for _, sub := range []string{"internal", "backend-platform-worker"} {
		raw := signedMachine(t, k.key, sub, "temporal-platform-worker", []string{"platform-automation:worker"}, func(c jwt.MapClaims, h map[string]any) { c["AuthType"] = "temporal" })
		if _, e = m.GetClaims(&authorization.AuthInfo{AuthToken: raw, Audience: "temporal-platform"}); e == nil {
			t.Fatal("JWT impersonated internal mapper")
		}
	}
	if _, e = m.GetClaims(&authorization.AuthInfo{Audience: "temporal-platform", TLSConnection: readerTLS}); e == nil {
		t.Fatal("reader peer without JWT gained health principal")
	}
}

func TestWorkerDescribeNamespaceIsExactReviewedSDKDelta(t *testing.T) {
	k, m, a := machineSetup(t)
	for _, p := range []struct{ sub, profile, ns string }{{"backend-platform-worker", "temporal-platform-worker", namespace}, {"backend-customer-worker", "temporal-customer-worker", "default"}} {
		c, e := m.GetClaims(&authorization.AuthInfo{AuthToken: signedMachine(t, k.key, p.sub, p.profile, []string{p.ns + ":worker"}, nil), Audience: "temporal-platform"})
		if e != nil {
			t.Fatal(e)
		}
		var typedNil *ws.DescribeNamespaceRequest
		for _, tc := range []struct {
			name, ns, method string
			req              any
			allow            bool
		}{
			{"own namespace", p.ns, "DescribeNamespace", &ws.DescribeNamespaceRequest{Namespace: p.ns}, true},
			{"target mismatch", "other", "DescribeNamespace", &ws.DescribeNamespaceRequest{Namespace: p.ns}, false},
			{"request mismatch", p.ns, "DescribeNamespace", &ws.DescribeNamespaceRequest{Namespace: "other"}, false},
			{"other namespace", "other", "DescribeNamespace", &ws.DescribeNamespaceRequest{Namespace: "other"}, false},
			{"id only", p.ns, "DescribeNamespace", &ws.DescribeNamespaceRequest{Id: "namespace-id"}, false},
			{"name plus id", p.ns, "DescribeNamespace", &ws.DescribeNamespaceRequest{Namespace: p.ns, Id: "namespace-id"}, false},
			{"nil", p.ns, "DescribeNamespace", nil, false},
			{"typed nil", p.ns, "DescribeNamespace", typedNil, false},
			{"wrong type", p.ns, "DescribeNamespace", &ws.DescribeWorkflowExecutionRequest{Namespace: p.ns}, false},
			{"wrong method", p.ns, "ListNamespaces", &ws.DescribeNamespaceRequest{Namespace: p.ns}, false},
		} {
			r, e := a.Authorize(context.Background(), c, &authorization.CallTarget{Namespace: tc.ns, APIName: prefix + tc.method, Request: tc.req})
			if e != nil || (r.Decision == authorization.DecisionAllow) != tc.allow {
				t.Errorf("%s/%s unexpected decision", p.profile, tc.name)
			}
		}
		forged := *c
		forged.Extensions = nil
		r, _ := a.Authorize(context.Background(), &forged, &authorization.CallTarget{Namespace: p.ns, APIName: prefix + "DescribeNamespace", Request: &ws.DescribeNamespaceRequest{Namespace: p.ns}})
		if r.Decision != authorization.DecisionDeny {
			t.Fatal("missing typed proof accepted")
		}
	}
	for _, p := range []struct {
		sub, profile, ns string
		permissions      []string
	}{{reader, "temporal-reader", namespace, []string{namespace + ":read"}}, {"backend-customer-client", "temporal-customer-client", "default", []string{"default:read", "default:write"}}} {
		info := &authorization.AuthInfo{AuthToken: signedMachine(t, k.key, p.sub, p.profile, p.permissions, nil), Audience: "temporal-platform"}
		if p.sub == reader {
			info.TLSConnection = verifiedTLS(t, reader, false)
		}
		c, e := m.GetClaims(info)
		if e != nil {
			t.Fatal(e)
		}
		r, _ := a.Authorize(context.Background(), c, &authorization.CallTarget{Namespace: p.ns, APIName: prefix + "DescribeNamespace", Request: &ws.DescribeNamespaceRequest{Namespace: p.ns}})
		if r.Decision != authorization.DecisionDeny {
			t.Fatal("reader/client DescribeNamespace widened")
		}
	}
}

func TestMachineReaderRequiresVerifiedMutualTLSOnEveryFrontend(t *testing.T) {
	k, m, _ := machineSetup(t)
	raw := signedMachine(t, k.key, reader, "temporal-reader", []string{namespace + ":read"}, nil)
	verified := verifiedTLS(t, reader, false)
	unverified := *verified
	unverified.State = verified.State
	unverified.State.VerifiedChains = nil
	for _, connection := range []*credentials.TLSInfo{verifiedJwtOnlyTLS(), &unverified} {
		if _, e := m.GetClaims(&authorization.AuthInfo{AuthToken: raw, Audience: "temporal-platform", TLSConnection: connection}); e == nil {
			t.Error("reader without a verified peer chain accepted on public frontend")
		}
	}
	worker := signedMachine(t, k.key, "backend-platform-worker", "temporal-platform-worker", []string{namespace + ":worker"}, nil)
	if _, e := m.GetClaims(&authorization.AuthInfo{AuthToken: worker, Audience: "temporal-platform", TLSConnection: verifiedJwtOnlyTLS()}); e != nil {
		t.Fatal("non-reader JWT-only frontend regressed")
	}
}
