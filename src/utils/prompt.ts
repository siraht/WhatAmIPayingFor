import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export const confirm = async (question: string): Promise<boolean> => {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
};
