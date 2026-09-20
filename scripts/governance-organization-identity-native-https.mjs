import https from "node:https";
import tls from "node:tls";
import dns from "node:dns/promises";
import { isIP } from "node:net";
import { types } from "node:util";
import { performance } from "node:perf_hooks";
import ipaddr from "../apps/api/node_modules/ipaddr.js/lib/ipaddr.js";
import { parseApprovalJson } from "./governance-approval-safe-json.mjs";
import {
  hasExactKeys,
  isPassivePlainData,
  isGitObjectId,
} from "./governance-organization-identity-controller-contracts.mjs";

const HOST = "api.github.com",
  PATH = "/repos/mlhjyx/global-backend/branches/main";
export const NATIVE_HTTPS_PROFILE_ID =
  "identity-protected-main-native-https/v1";
const hold = (code) => ({ status: "HOLD", code, admissionGranted: false });
function normalizedIp(address) {
  return ipaddr.process(address).toString();
}
function safeAnswers(answers) {
  return (
    isPassivePlainData(answers) &&
    Array.isArray(answers) &&
    answers.length > 0 &&
    answers.length <= 16 &&
    answers.every(
      (a) =>
        hasExactKeys(a, ["address", "family"]) &&
        typeof a.address === "string" &&
        [4, 6].includes(a.family) &&
        isIP(a.address) === a.family &&
        ipaddr.process(a.address).range() === "unicast",
    )
  );
}
function responseHeaders(response) {
  const fields = new Map();
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    const key = response.rawHeaders[i].toLowerCase();
    fields.set(key, [...(fields.get(key) ?? []), response.rawHeaders[i + 1]]);
  }
  const contentType = fields.get("content-type");
  if (
    contentType?.length !== 1 ||
    !/^application\/(?:json|vnd\.github\+json)(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/iu.test(
      contentType[0],
    )
  )
    throw Error("headers");
  const encoding = fields.get("content-encoding");
  if (
    encoding &&
    (encoding.length !== 1 || encoding[0].toLowerCase() !== "identity")
  )
    throw Error("encoding");
  const length = fields.get("content-length");
  if (
    length &&
    (length.length !== 1 ||
      !/^(0|[1-9][0-9]{0,9})$/u.test(length[0]) ||
      Number(length[0]) > 65536)
  )
    throw Error("length");
  return length ? Number(length[0]) : null;
}

// Fixed-endpoint transport only. Caller must establish installed source/tool/CA,
// request/credential authority and remaining whole-controller deadline first.
// No endpoint, resolver, proxy or TLS-verification override is accepted here.
export async function readProtectedMainHttps(
  credentialBytes,
  caBytes,
  timeoutMs,
) {
  if (
    types.isProxy(credentialBytes) ||
    types.isProxy(caBytes) ||
    !Buffer.isBuffer(credentialBytes) ||
    !Buffer.isBuffer(caBytes) ||
    credentialBytes.length < 1 ||
    credentialBytes.length > 8192 ||
    !credentialBytes.every((b) => b >= 0x21 && b <= 0x7e) ||
    caBytes.length < 1 ||
    caBytes.length > 1048576 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 15000
  )
    return hold("NATIVE_HTTPS_INPUT_INVALID");
  const credential = Buffer.from(credentialBytes),
    ca = Buffer.from(caBytes),
    deadline = performance.now() + timeoutMs;
  let dnsTimer;
  try {
    let answers;
    try {
      answers = await Promise.race([
        dns.lookup(HOST, { all: true, verbatim: true }),
        new Promise((_, reject) => {
          dnsTimer = setTimeout(
            () => reject("DNS_TIMEOUT"),
            Math.min(5000, Math.max(1, deadline - performance.now())),
          );
        }),
      ]);
    } catch (error) {
      return hold(
        error === "DNS_TIMEOUT"
          ? "NATIVE_HTTPS_DNS_TIMEOUT"
          : "NATIVE_HTTPS_DNS_FAILED",
      );
    } finally {
      clearTimeout(dnsTimer);
    }
    if (performance.now() >= deadline) return hold("NATIVE_HTTPS_DNS_TIMEOUT");
    if (!safeAnswers(answers)) return hold("NATIVE_HTTPS_DNS_UNSAFE");
    const selected = { ...answers[0] };
    return await new Promise((resolve) => {
      let request,
        response,
        timer,
        agent,
        settled = false,
        peerVerified = false,
        total = 0,
        expectedLength = null;
      const chunks = [];
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        response?.destroy();
        request?.destroy();
        agent?.destroy();
        for (const chunk of chunks) chunk.fill(0);
        chunks.length = 0;
        resolve(result);
      };
      const fail = (code) => finish(hold(code));
      timer = setTimeout(
        () => fail("NATIVE_HTTPS_TIMEOUT"),
        Math.max(1, deadline - performance.now()),
      );
      try {
        agent = new https.Agent({
          keepAlive: false,
          maxSockets: 1,
          maxCachedSessions: 0,
        });
        request = https.request(
          {
            protocol: "https:",
            hostname: HOST,
            port: 443,
            path: PATH,
            method: "GET",
            agent,
            ca,
            rejectUnauthorized: true,
            checkServerIdentity: tls.checkServerIdentity,
            servername: HOST,
            minVersion: "TLSv1.2",
            maxHeaderSize: 8192,
            autoSelectFamily: false,
            family: selected.family,
            lookup: (hostname, options, callback) => {
              if (
                settled ||
                performance.now() >= deadline ||
                hostname !== HOST
              ) {
                callback(Error("PINNED_LOOKUP_REFUSED"));
                return;
              }
              if (options.all) callback(null, [selected]);
              else callback(null, selected.address, selected.family);
            },
            headers: {
              Host: HOST,
              Accept: "application/vnd.github+json",
              "Accept-Encoding": "identity",
              "User-Agent": "identity-protected-main-controller/1",
              "X-GitHub-Api-Version": "2022-11-28",
              Authorization: "Bearer " + credential.toString("ascii"),
            },
          },
          (res) => {
            response = res;
            if (settled) {
              res.destroy();
              return;
            }
            if (performance.now() >= deadline) {
              fail("NATIVE_HTTPS_TIMEOUT");
              return;
            }
            if (!peerVerified) {
              fail("NATIVE_HTTPS_PEER_MISMATCH");
              return;
            }
            if (res.statusCode !== 200) {
              fail("NATIVE_HTTPS_STATUS_REJECTED");
              return;
            }
            try {
              expectedLength = responseHeaders(res);
            } catch {
              fail("NATIVE_HTTPS_HEADERS_INVALID");
              return;
            }
            res.on("data", (chunk) => {
              if (settled) return;
              if (performance.now() >= deadline) {
                fail("NATIVE_HTTPS_TIMEOUT");
                return;
              }
              total += chunk.length;
              if (total > 65536) {
                fail("NATIVE_HTTPS_BODY_LIMIT");
                return;
              }
              chunks.push(Buffer.from(chunk));
            });
            res.on("aborted", () => fail("NATIVE_HTTPS_STREAM_FAILED"));
            res.on("error", () => fail("NATIVE_HTTPS_STREAM_FAILED"));
            res.on("end", () => {
              if (settled) return;
              if (performance.now() >= deadline) {
                fail("NATIVE_HTTPS_TIMEOUT");
                return;
              }
              if (
                !res.complete ||
                (expectedLength !== null && total !== expectedLength)
              ) {
                fail("NATIVE_HTTPS_STREAM_FAILED");
                return;
              }
              let bytes;
              try {
                bytes = Buffer.concat(chunks, total);
                const value = parseApprovalJson(
                  new TextDecoder("utf-8", { fatal: true }).decode(bytes),
                  "protected-main",
                );
                if (
                  value?.name !== "main" ||
                  !isGitObjectId(value?.commit?.sha) ||
                  value?.protected !== true
                )
                  throw Error("observation");
                if (performance.now() >= deadline) {
                  fail("NATIVE_HTTPS_TIMEOUT");
                  return;
                }
                finish({
                  status: "PASS",
                  evidenceClass: "OPERATION_RESULT_ONLY",
                  admissionGranted: false,
                  profileId: NATIVE_HTTPS_PROFILE_ID,
                  observation: Object.freeze({
                    headSha: value.commit.sha,
                    protected: true,
                  }),
                  rawBodyBytes: total,
                  httpExchanges: 1,
                });
              } catch {
                fail("NATIVE_HTTPS_RESPONSE_INVALID");
              } finally {
                bytes?.fill(0);
              }
            });
          },
        );
        request.on("error", () => fail("NATIVE_HTTPS_REQUEST_FAILED"));
        request.on("socket", (socket) => {
          socket.once("secureConnect", () => {
            if (settled) return;
            if (performance.now() >= deadline) {
              fail("NATIVE_HTTPS_TIMEOUT");
              return;
            }
            try {
              if (
                !socket.authorized ||
                normalizedIp(socket.remoteAddress) !==
                  normalizedIp(selected.address)
              ) {
                fail("NATIVE_HTTPS_PEER_MISMATCH");
                return;
              }
              socket.disableRenegotiation();
              peerVerified = true;
              request.end();
            } catch {
              fail("NATIVE_HTTPS_PEER_MISMATCH");
            }
          });
        });
      } catch {
        fail("NATIVE_HTTPS_REQUEST_FAILED");
      }
    });
  } catch {
    return hold("NATIVE_HTTPS_FAILED");
  } finally {
    clearTimeout(dnsTimer);
    credential.fill(0);
    ca.fill(0);
  }
}
