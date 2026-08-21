/** Bounded concurrent map with stable result ordering. */
export async function mapWithConcurrency<Input, Output>(
  inputs: readonly Input[],
  requested: number,
  task: (input: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (0 === inputs.length) return [];
  const concurrency = Math.max(1, Math.min(inputs.length, Math.floor(requested)));
  const results = new Map<number, Output>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < inputs.length) {
      const index = next;
      next += 1;
      const input = inputs[index] as Input;
      results.set(index, await task(input, index));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return inputs.map((_input, index) => {
    if (!results.has(index)) throw new Error(`parallel task ${String(index)} produced no result`);
    return results.get(index) as Output;
  });
}
