import { NativeConnection } from "@temporalio/worker";
import type { MachineTokenClient } from "../platform-authority/machine-token-client";
import type { VerifiedMachineToken } from "../platform-authority/machine-token-verifier";
import { temporalTlsConfiguration } from "../platform-authority/machine-token-runtime";

/** Native SDK stores a string, unlike the JS client's synchronous getter. */
export function bindNativeMachineCredential(
  client: Pick<MachineTokenClient, "currentToken" | "subscribe">,
  connection: Pick<NativeConnection, "setApiKey">,
  onUnavailable: () => void,
): () => void {
  let stopped = false;
  let pending = Promise.resolve();
  const fail = () => {
    if (!stopped) {
      stopped = true;
      // Empty API key removes the stored bearer; native polling is stopped too.
      void connection.setApiKey("").catch(() => undefined);
      onUnavailable();
    }
  };
  const unsubscribe = client.subscribe(
    (credential: VerifiedMachineToken | null) => {
      if (stopped) return;
      if (!credential) {
        fail();
        return;
      }
      pending = pending
        .then(async () => {
          if (stopped) return;
          // Re-read at installation time; never install an expired queued update.
          await connection.setApiKey(client.currentToken());
        })
        .catch(fail);
    },
  );
  return () => {
    stopped = true;
    unsubscribe();
  };
}

export async function connectNativeMachine(
  client: MachineTokenClient,
): Promise<NativeConnection> {
  return NativeConnection.connect({
    ...(await temporalTlsConfiguration()),
    apiKey: client.currentToken(),
  });
}
