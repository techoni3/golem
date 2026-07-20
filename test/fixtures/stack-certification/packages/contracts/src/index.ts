export type EchoMessage = {
  message: string;
};

export function normalizeMessage(input: EchoMessage): EchoMessage {
  return { message: input.message.trim() };
}
