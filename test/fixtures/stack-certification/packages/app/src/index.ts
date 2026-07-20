import { type EchoMessage, normalizeMessage } from "@golem-stack/contracts";

export function runCertificationMessage(input: EchoMessage): EchoMessage {
  return normalizeMessage(input);
}
