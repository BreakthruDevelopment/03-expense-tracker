/**
 * Recorded answers keyed by task name. Demo mode keeps live demos working when the
 * free model quota is used up, and lets tests run without a network or API key.
 * Each app adds a fixture for each AI task it defines.
 */
export const demoFixtures: Record<string, unknown> = {
  // Matches the synthetic public/demo-receipts/bluebird-coffee.png.
  "extract-receipt": {
    isReceipt: true,
    merchant: "Bluebird Coffee",
    date: "2026-10-14",
    currency: "USD",
    total: 12.4,
    tax: 0.95,
    category: "meals",
    lineItems: [
      { description: "Oat latte", amount: 5.75 },
      { description: "Almond croissant", amount: 5.7 },
    ],
    confidence: "high",
  },
};

export function demoAnswer(task: string): string {
  const fixture = demoFixtures[task];
  if (fixture === undefined) {
    throw new Error(`No demo fixture for AI task "${task}". Add one to src/lib/ai/demo.ts.`);
  }
  return JSON.stringify(fixture);
}
