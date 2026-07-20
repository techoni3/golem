import { z } from 'zod';

export const EchoInput = z.object({ message: z.string().trim().min(1) });
export const EchoOutput = z.object({ message: z.string().min(1) });

export function validateMcpInput(input) {
  return EchoInput.parse(input);
}
