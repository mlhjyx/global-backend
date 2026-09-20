package readerpolicy

import (
	"context"
	"encoding/asn1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"reflect"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"

	commonpb "go.temporal.io/api/common/v1"
	enumspb "go.temporal.io/api/enums/v1"
	taskqueuepb "go.temporal.io/api/taskqueue/v1"
	ws "go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/server/common/authorization"
	"go.temporal.io/server/common/tasktoken"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
)

// MachineConfig is deployment-owned. No claim selects an issuer, namespace,
// subject, audience, queue, or additional authority.
type MachineConfig struct {
	Issuer, Audience                                                                   string
	ReaderSubject, PlatformWorkerSubject, CustomerWorkerSubject, CustomerClientSubject string
	ProvisionAdminSubject, ScheduleWriterSubject                                       string
}
type machineIdentity struct {
	subject, namespace, profile string
	role                        authorization.Role
	permissions                 []string
}
type verifiedMachine struct {
	identity    machineIdentity
	readerProof any
}
type verifiedAnonymousHealth struct{}
type machineMapper struct {
	delegate authorization.ClaimMapper
	config   MachineConfig
}
type machineAuthorizer struct {
	delegate authorization.Authorizer
	config   MachineConfig
}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var kidPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
var stickySuffixPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)
var audiencePattern = regexp.MustCompile(`^[\x21-\x7e]{1,256}$`)

func (c MachineConfig) identities() []machineIdentity {
	return []machineIdentity{
		{c.ReaderSubject, "platform-automation", "temporal-reader", authorization.RoleReader, []string{"platform-automation:read"}},
		{c.PlatformWorkerSubject, "platform-automation", "temporal-platform-worker", authorization.RoleWorker, []string{"platform-automation:worker"}},
		{c.CustomerWorkerSubject, "default", "temporal-customer-worker", authorization.RoleWorker, []string{"default:worker"}},
		{c.CustomerClientSubject, "default", "temporal-customer-client", authorization.RoleReader | authorization.RoleWriter, []string{"default:read", "default:write"}},
		{c.ProvisionAdminSubject, "", "", authorization.RoleAdmin, []string{"temporal-system:admin"}},
		{c.ScheduleWriterSubject, "platform-automation", "", authorization.RoleWriter, []string{"platform-automation:write"}},
	}
}
func (c MachineConfig) validate() error {
	u, e := url.Parse(c.Issuer)
	if e != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || len(utf16.Encode([]rune(c.Issuer))) > 2048 || strings.IndexFunc(c.Issuer, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 || (u.Scheme != "https" && !(u.Scheme == "http" && (strings.ToLower(u.Hostname()) == "localhost" || u.Hostname() == "127.0.0.1"))) || !audiencePattern.MatchString(c.Audience) {
		return errors.New("TEMPORAL_MACHINE_CONFIG_INVALID")
	}
	seen := map[string]bool{}
	for _, id := range c.identities() {
		if !validSubject(id.subject) || seen[id.subject] {
			return errors.New("TEMPORAL_MACHINE_CONFIG_INVALID")
		}
		seen[id.subject] = true
	}
	return nil
}
func NewMachineClaimMapper(delegate authorization.ClaimMapper, c MachineConfig) (authorization.ClaimMapper, error) {
	if delegate == nil {
		return nil, errors.New("TEMPORAL_MACHINE_CONFIG_INVALID")
	}
	if e := c.validate(); e != nil {
		return nil, e
	}
	return &machineMapper{delegate, c}, nil
}
func NewMachineAuthorizer(delegate authorization.Authorizer, c MachineConfig) (authorization.Authorizer, error) {
	if delegate == nil {
		return nil, errors.New("TEMPORAL_MACHINE_CONFIG_INVALID")
	}
	if e := c.validate(); e != nil {
		return nil, e
	}
	return &machineAuthorizer{delegate, c}, nil
}

// Decode only after the official signature delegate succeeds. Reject duplicate
// JSON members as well as unknown fields; these checks never replace signatures.
func closedObject(encoded string, fields string) (map[string]any, bool) {
	raw, e := base64.RawURLEncoding.DecodeString(encoded)
	if e != nil {
		return nil, false
	}
	d := json.NewDecoder(strings.NewReader(string(raw)))
	d.UseNumber()
	tok, e := d.Token()
	if e != nil || tok != json.Delim('{') {
		return nil, false
	}
	out := map[string]any{}
	allowed := map[string]bool{}
	for _, k := range strings.Fields(fields) {
		allowed[k] = true
	}
	for d.More() {
		k, e := d.Token()
		key, ok := k.(string)
		if e != nil || !ok || !allowed[key] {
			return nil, false
		}
		if _, ok = out[key]; ok {
			return nil, false
		}
		var v any
		if d.Decode(&v) != nil {
			return nil, false
		}
		out[key] = v
	}
	if tok, e = d.Token(); e != nil || tok != json.Delim('}') {
		return nil, false
	}
	if _, e = d.Token(); e != io.EOF {
		return nil, false
	}
	return out, true
}
func exactPermissions(value any, want []string) bool {
	a, ok := value.([]any)
	if !ok || len(a) != len(want) {
		return false
	}
	seen := map[string]bool{}
	for _, v := range a {
		s, ok := v.(string)
		if !ok || seen[s] {
			return false
		}
		seen[s] = true
	}
	for _, s := range want {
		if !seen[s] {
			return false
		}
	}
	return true
}
func exactMachineRoles(c *authorization.Claims, id machineIdentity) bool {
	if id.namespace == "" {
		return c.System == id.role && len(c.Namespaces) == 0
	}
	return c.System == authorization.RoleUndefined && len(c.Namespaces) == 1 && c.Namespaces[id.namespace] == id.role
}
func (m *machineMapper) GetClaims(info *authorization.AuthInfo) (*authorization.Claims, error) {
	if info == nil || len(info.AuthToken) > 16384+len("Bearer ") || info.Audience != m.config.Audience {
		return nil, denied()
	}
	snapshot := *info
	raw := snapshot.AuthToken
	c, e := m.delegate.GetClaims(&snapshot)
	if e != nil || c == nil || snapshot.AuthToken != raw || c.AuthType != "jwt" {
		return nil, denied()
	}
	// Preserve only Temporal's existing unauthenticated health baseline. The
	// reader delegate has already rejected reader certificates without their JWT.
	if raw == "" && c.Subject == "" && c.System == authorization.RoleUndefined && len(c.Namespaces) == 0 && c.Extensions == nil {
		copy := *c
		copy.Extensions = verifiedAnonymousHealth{}
		return &copy, nil
	}
	var id machineIdentity
	found := false
	for _, candidate := range m.config.identities() {
		if candidate.subject == c.Subject {
			id = candidate
			found = true
			break
		}
	}
	if !found || !exactMachineRoles(c, id) {
		return nil, denied()
	}
	if id.profile == "temporal-reader" {
		// R4 reader credentials require a real peer proof on every frontend,
		// including the otherwise JWT-only public listener.
		if info.TLSConnection == nil || !info.TLSConnection.State.HandshakeComplete || len(info.TLSConnection.State.VerifiedChains) == 0 {
			return nil, denied()
		}
		leaf := verifiedPeerLeaf(info)
		if leaf == nil || !singleReaderIdentity(leaf, id.subject) {
			return nil, denied()
		}
		now := time.Now()
		for _, chain := range info.TLSConnection.State.VerifiedChains {
			for _, cert := range chain {
				if cert == nil || now.Before(cert.NotBefore) || !now.Before(cert.NotAfter) {
					return nil, denied()
				}
			}
		}
	}
	parts := strings.SplitN(raw, " ", 2)
	if len(parts) != 2 {
		return nil, denied()
	}
	compact := strings.Split(parts[1], ".")
	if len(compact) != 3 {
		return nil, denied()
	}
	for _, segment := range compact {
		decoded, err := base64.RawURLEncoding.DecodeString(segment)
		if err != nil || base64.RawURLEncoding.EncodeToString(decoded) != segment {
			return nil, denied()
		}
	}
	fields := "iss aud sub profile jti iat nbf exp permissions"
	body, ok := closedObject(compact[1], fields)
	if !ok || body["sub"] != id.subject || body["aud"] != m.config.Audience || !exactPermissions(body["permissions"], id.permissions) {
		return nil, denied()
	}
	header, ok := closedObject(compact[0], "alg kid typ")
	kid, _ := header["kid"].(string)
	if !ok || header["alg"] != "RS256" || !kidPattern.MatchString(kid) {
		return nil, denied()
	}
	if id.profile != "" {
		if len(body) != 9 || len(header) != 3 || header["typ"] != "temporal-runtime+jwt" || body["iss"] != m.config.Issuer || body["profile"] != id.profile {
			return nil, denied()
		}
		jti, _ := body["jti"].(string)
		if !uuidPattern.MatchString(jti) {
			return nil, denied()
		}
		times := map[string]int64{}
		for _, k := range []string{"iat", "nbf", "exp"} {
			v, ok := body[k].(json.Number)
			if !ok {
				return nil, denied()
			}
			n, e := v.Int64()
			if e != nil || n < 0 {
				return nil, denied()
			}
			times[k] = n
		}
		now := time.Now().Unix()
		if times["exp"] <= now || times["iat"] > now+60 || times["nbf"] > now+60 || times["nbf"] < times["iat"] || times["nbf"] >= times["exp"] || times["exp"]-times["iat"] != 300 {
			return nil, denied()
		}
	} else if body["profile"] != nil || header["typ"] != "JWT" {
		return nil, denied()
	}
	copy := *c
	copy.Extensions = verifiedMachine{id, c.Extensions}
	return &copy, nil
}

// Worker identity is subject:runtimeInstanceUuid. SDK 1.23.0 appends a simple
// UUID to that identity for sticky queues (sdk-core/src/lib.rs).
func workerIdentity(value, subject string) bool {
	return strings.HasPrefix(value, subject+":") && uuidPattern.MatchString(strings.TrimPrefix(value, subject+":"))
}
func stickyQueue(value, identity string) bool {
	suffix := strings.TrimPrefix(value, identity+"-")
	return value != suffix && stickySuffixPattern.MatchString(suffix)
}
func workerQueue(q *taskqueuepb.TaskQueue, identity string, sticky bool) bool {
	if q == nil {
		return false
	}
	switch q.Kind {
	case enumspb.TASK_QUEUE_KIND_UNSPECIFIED, enumspb.TASK_QUEUE_KIND_NORMAL:
		return q.Name == "understanding" && (q.NormalName == "" || q.NormalName == "understanding")
	case enumspb.TASK_QUEUE_KIND_STICKY:
		return sticky && q.NormalName == "understanding" && stickyQueue(q.Name, identity)
	}
	return false
}

var workerRequests = map[string]reflect.Type{
	"DescribeNamespace":     reflect.TypeOf((*ws.DescribeNamespaceRequest)(nil)),
	"PollWorkflowTaskQueue": reflect.TypeOf((*ws.PollWorkflowTaskQueueRequest)(nil)), "PollActivityTaskQueue": reflect.TypeOf((*ws.PollActivityTaskQueueRequest)(nil)),
	"RespondWorkflowTaskCompleted": reflect.TypeOf((*ws.RespondWorkflowTaskCompletedRequest)(nil)), "RespondWorkflowTaskFailed": reflect.TypeOf((*ws.RespondWorkflowTaskFailedRequest)(nil)), "RespondQueryTaskCompleted": reflect.TypeOf((*ws.RespondQueryTaskCompletedRequest)(nil)),
	"RecordActivityTaskHeartbeat": reflect.TypeOf((*ws.RecordActivityTaskHeartbeatRequest)(nil)), "RecordActivityTaskHeartbeatById": reflect.TypeOf((*ws.RecordActivityTaskHeartbeatByIdRequest)(nil)),
	"RespondActivityTaskCompleted": reflect.TypeOf((*ws.RespondActivityTaskCompletedRequest)(nil)), "RespondActivityTaskCompletedById": reflect.TypeOf((*ws.RespondActivityTaskCompletedByIdRequest)(nil)),
	"RespondActivityTaskFailed": reflect.TypeOf((*ws.RespondActivityTaskFailedRequest)(nil)), "RespondActivityTaskFailedById": reflect.TypeOf((*ws.RespondActivityTaskFailedByIdRequest)(nil)),
	"RespondActivityTaskCanceled": reflect.TypeOf((*ws.RespondActivityTaskCanceledRequest)(nil)), "RespondActivityTaskCanceledById": reflect.TypeOf((*ws.RespondActivityTaskCanceledByIdRequest)(nil)),
	"GetWorkflowExecutionHistory": reflect.TypeOf((*ws.GetWorkflowExecutionHistoryRequest)(nil)), "ResetStickyTaskQueue": reflect.TypeOf((*ws.ResetStickyTaskQueueRequest)(nil)),
	"ShutdownWorker": reflect.TypeOf((*ws.ShutdownWorkerRequest)(nil)), "RecordWorkerHeartbeat": reflect.TypeOf((*ws.RecordWorkerHeartbeatRequest)(nil)),
}
var clientRequests = map[string]reflect.Type{
	"StartWorkflowExecution": reflect.TypeOf((*ws.StartWorkflowExecutionRequest)(nil)), "DescribeWorkflowExecution": reflect.TypeOf((*ws.DescribeWorkflowExecutionRequest)(nil)),
	"GetWorkflowExecutionHistory": reflect.TypeOf((*ws.GetWorkflowExecutionHistoryRequest)(nil)), "RequestCancelWorkflowExecution": reflect.TypeOf((*ws.RequestCancelWorkflowExecutionRequest)(nil)),
}

func typedMethod(t *authorization.CallTarget, allowed map[string]reflect.Type) bool {
	if !strings.HasPrefix(t.APIName, workflowService) || t.Request == nil {
		return false
	}
	want, ok := allowed[strings.TrimPrefix(t.APIName, workflowService)]
	return ok && reflect.TypeOf(t.Request) == want && !reflect.ValueOf(t.Request).IsNil()
}
func machineHealth(t *authorization.CallTarget) bool {
	if t.Namespace != "" {
		return false
	}
	switch r := t.Request.(type) {
	case *ws.GetSystemInfoRequest:
		return r != nil && t.APIName == workflowService+"GetSystemInfo"
	case *healthpb.HealthCheckRequest:
		return r != nil && t.APIName == "/grpc.health.v1.Health/Check"
	}
	return false
}
func validWorkerRequest(t *authorization.CallTarget, id machineIdentity) bool {
	if !typedMethod(t, workerRequests) {
		return false
	}
	if r, ok := t.Request.(interface{ GetIdentity() string }); ok && !workerIdentity(r.GetIdentity(), id.subject) {
		return false
	}
	switch r := t.Request.(type) {
	case *ws.DescribeNamespaceRequest:
		// SDK Worker.validate requires its own namespace's capabilities. Never
		// permit the alternate ID selector to override the bound namespace name.
		return r.Id == ""
	case *ws.PollWorkflowTaskQueueRequest:
		return workerQueue(r.TaskQueue, r.Identity, true)
	case *ws.PollActivityTaskQueueRequest:
		return workerQueue(r.TaskQueue, r.Identity, false)
	case *ws.RespondWorkflowTaskCompletedRequest:
		if r.StickyAttributes != nil {
			q := r.StickyAttributes.WorkerTaskQueue
			if q == nil || q.Kind != enumspb.TASK_QUEUE_KIND_STICKY || !workerQueue(q, r.Identity, true) {
				return false
			}
		}
	case *ws.ShutdownWorkerRequest:
		if r.TaskQueue != "" && r.TaskQueue != "understanding" {
			return false
		}
		if r.StickyTaskQueue != "" && !stickyQueue(r.StickyTaskQueue, r.Identity) {
			return false
		}
		if r.WorkerHeartbeat != nil && r.WorkerHeartbeat.TaskQueue != "understanding" {
			return false
		}
	case *ws.RecordWorkerHeartbeatRequest:
		for _, h := range r.WorkerHeartbeat {
			if h == nil || h.TaskQueue != "understanding" {
				return false
			}
		}
	}
	if r, ok := t.Request.(interface{ GetTaskToken() []byte }); ok {
		raw := r.GetTaskToken()
		if len(raw) == 0 || len(raw) > 65536 {
			return false
		}
		s := tasktoken.NewSerializer()
		if _, query := t.Request.(*ws.RespondQueryTaskCompletedRequest); query {
			tok, e := s.DeserializeQueryTaskToken(raw)
			return e == nil && tok.NamespaceId != "" && tok.TaskId != "" && tok.TaskQueue != ""
		}
		tok, e := s.Deserialize(raw)
		return e == nil && tok.NamespaceId != "" && tok.WorkflowId != "" && tok.RunId != "" && tok.ScheduledEventId > 0
	}
	return true
}
func (a *machineAuthorizer) Authorize(ctx context.Context, c *authorization.Claims, t *authorization.CallTarget) (authorization.Result, error) {
	deny := authorization.Result{Decision: authorization.DecisionDeny, Reason: "TEMPORAL_MACHINE_POLICY_DENIED"}
	if t == nil {
		return deny, nil
	}
	if c == nil {
		if machineHealth(t) {
			return authorization.Result{Decision: authorization.DecisionAllow}, nil
		}
		return deny, nil
	}
	// Upstream v1.31.2 installs NewInternalClaimMapper only on internal-frontend
	// (temporal/fx.go). Public JWT mapping can never produce AuthType=temporal.
	// Preserve that native authority only behind the already validated, separate
	// internode mTLS listener; never infer it from a JWT subject or claim.
	if c.AuthType == "temporal" && c.Subject == "internal" && c.System == authorization.RoleAdmin && len(c.Namespaces) == 0 && c.Extensions == nil {
		if !verifiedInternodePeer(ctx, a.config.ReaderSubject) {
			return deny, nil
		}
		return a.delegate.Authorize(ctx, c, t)
	}
	if _, anonymous := c.Extensions.(verifiedAnonymousHealth); anonymous {
		if c.Subject == "" && c.AuthType == "jwt" && c.System == authorization.RoleUndefined && len(c.Namespaces) == 0 && machineHealth(t) {
			return authorization.Result{Decision: authorization.DecisionAllow}, nil
		}
		return deny, nil
	}
	proof, ok := c.Extensions.(verifiedMachine)
	if !ok || proof.identity.subject != c.Subject || !exactMachineRoles(c, proof.identity) {
		return deny, nil
	}
	id := proof.identity
	if id.profile == "" {
		return a.delegate.Authorize(ctx, c, t)
	}
	if id.profile == "temporal-reader" {
		copy := *c
		copy.Extensions = proof.readerProof
		return a.delegate.Authorize(ctx, &copy, t)
	}
	allow := machineHealth(t)
	if !allow {
		ns, ok := t.Request.(interface{ GetNamespace() string })
		if !ok || t.Namespace != id.namespace || ns.GetNamespace() != id.namespace {
			return deny, nil
		}
		if id.role == authorization.RoleWorker {
			allow = validWorkerRequest(t, id)
		} else {
			allow = typedMethod(t, clientRequests)
			if r, ok := t.Request.(*ws.StartWorkflowExecutionRequest); ok {
				allow = allow && workerQueue(r.TaskQueue, "", false)
			}
		}
	}
	if !allow {
		return deny, nil
	}
	return authorization.Result{Decision: authorization.DecisionAllow, Principal: &commonpb.Principal{Type: c.AuthType, Name: c.Subject}}, nil
}

func verifiedInternodePeer(ctx context.Context, readerSubject string) bool {
	info := authorization.TLSInfoFromContext(ctx)
	leaf := verifiedPeerLeaf(&authorization.AuthInfo{TLSConnection: info})
	if leaf == nil || leaf.Subject.CommonName == readerSubject {
		return false
	}
	for _, name := range leaf.Subject.Names {
		if name.Type.Equal(asn1.ObjectIdentifier{2, 5, 4, 3}) && name.Value == readerSubject {
			return false
		}
	}
	now := time.Now()
	for _, chain := range info.State.VerifiedChains {
		for _, cert := range chain {
			if cert == nil || now.Before(cert.NotBefore) || !now.Before(cert.NotAfter) {
				return false
			}
		}
	}
	return true
}
