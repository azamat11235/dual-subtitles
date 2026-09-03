/** Точка входа: node test/run.mjs */
import './parse.test.mjs';
import './translate.test.mjs';
import { runAll } from './harness.mjs';

await runAll();
