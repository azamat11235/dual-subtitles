/** Tiny runner: collects the tests and prints a report. No dependencies. */
const tests = [];

export function test(name, fn) {
  tests.push({ name, fn });
}

export async function runAll() {
  let passed = 0;
  const failures = [];
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log('  \x1b[32mok\x1b[0m   ' + t.name);
    } catch (e) {
      failures.push({ name: t.name, error: e });
      console.log('  \x1b[31mFAIL\x1b[0m ' + t.name);
      console.log('       ' + String(e.message).split('\n').join('\n       '));
    }
  }
  console.log(`\n${passed}/${tests.length} tests passed`);
  if (failures.length) process.exitCode = 1;
  return failures.length === 0;
}
